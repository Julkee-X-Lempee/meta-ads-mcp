#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { loadConfig, AdsConfig } from "./config.js";
import { AdsClient } from "./services/ads-client.js";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

export const requestStorage = new AsyncLocalStorage<Map<string, string>>();

// --- Tool imports ---
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAdsetTools } from "./tools/adsets.js";
import { registerAdTools } from "./tools/ads.js";
import { registerCreativeTools } from "./tools/creatives.js";
import { registerImageTools } from "./tools/images.js";
import { registerVideoTools } from "./tools/videos.js";
import { registerCanvasTools } from "./tools/canvas.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerTargetingTools } from "./tools/targeting.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerLeadTools } from "./tools/leads.js";
import { registerCatalogTools } from "./tools/catalogs.js";
import { registerFeedTools } from "./tools/feeds.js";
import { registerRuleTools } from "./tools/rules.js";
import { registerExperimentTools } from "./tools/experiments.js";
import { registerConversionTools } from "./tools/conversions.js";
import { registerBudgetTools } from "./tools/budget.js";
import { registerReachFrequencyTools } from "./tools/reach_frequency.js";
import { registerBrandSafetyTools } from "./tools/brand_safety.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBusinessTools } from "./tools/business.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerAdLibraryTools } from "./tools/ad_library.js";

// --- Resources & Prompts ---
import { registerResources } from "./resources/account.js";
import { registerPrompts } from "./prompts/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const config = loadConfig();
const client = new AdsClient(config);

function registerAllTools(s: McpServer) {
  // --- Campaign Management ---
  registerCampaignTools(s, client);
  registerAdsetTools(s, client);
  registerAdTools(s, client);
  registerCreativeTools(s, client);

  // --- Assets ---
  registerImageTools(s, client);
  registerVideoTools(s, client);
  registerCanvasTools(s, client);

  // --- Audience & Targeting ---
  registerAudienceTools(s, client);
  registerTargetingTools(s, client);

  // --- Insights & Reporting ---
  registerInsightTools(s, client);

  // --- Leads ---
  registerLeadTools(s, client);

  // --- Catalog & Commerce ---
  registerCatalogTools(s, client);
  registerFeedTools(s, client);

  // --- Automation ---
  registerRuleTools(s, client);
  registerExperimentTools(s, client);

  // --- Pixel & Conversions ---
  registerConversionTools(s, client);

  // --- Budget & Planning ---
  registerBudgetTools(s, client);
  registerReachFrequencyTools(s, client);

  // --- Brand Safety ---
  registerBrandSafetyTools(s, client);

  // --- Account & Business ---
  registerAccountTools(s, client);
  registerBusinessTools(s, client);

  // --- Auth & Token ---
  registerAuthTools(s, client);

  // --- Ad Library ---
  registerAdLibraryTools(s, client);

  // --- Resources & Prompts ---
  registerResources(s, client);
  registerPrompts(s);

  // --- Session Account Switching ---
  s.tool(
    "select_ad_account",
    "Select and switch the active Meta ad account for all subsequent operations in this session. Use this to query another client's ad account.",
    {
      ad_account_id: z.string().describe("The Meta ad account ID to switch to (e.g. 'act_12345' or '12345')"),
    },
    async ({ ad_account_id }) => {
      const store = requestStorage.getStore();
      if (!store) {
        return { content: [{ type: "text" as const, text: "Error: No session storage active." }], isError: true };
      }
      const normalizedId = ad_account_id.replace(/^act_/, "");
      store.set("adAccountId", normalizedId);
      console.log(`[select_ad_account] Switched active session adAccountId to: act_${normalizedId}`);
      return { content: [{ type: "text" as const, text: `Successfully switched active ad account to act_${normalizedId}` }] };
    }
  );
}

async function main() {
  const portEnv = process.env.PORT || (process.env.K_SERVICE ? "8080" : null);
  const useSse = process.env.TRANSPORT === "sse" || !!portEnv;

  if (useSse) {
    const app = express();
    app.use(express.json());

    const transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (req, res) => {
      const adAccountId = req.headers["x-meta-ad-account-id"] as string;
      const store = new Map<string, string>();
      if (adAccountId) {
        store.set("adAccountId", adAccountId);
      }

      const transport = new SSEServerTransport("/messages", res);
      console.log(`[SSE] New connection request. Generated sessionId: ${transport.sessionId}, adAccountId: ${adAccountId}`);
      
      // Store reference context in the transport session object
      const transportStore = new Map<string, string>();
      if (adAccountId) transportStore.set("adAccountId", adAccountId);
      (transport as any)._store = transportStore;

      transports.set(transport.sessionId, transport);
      console.log(`[SSE] Registered session: ${transport.sessionId}. Current Map size: ${transports.size}, active sessions:`, Array.from(transports.keys()));

      // Create a separate McpServer instance for this connection
      const connectionServer = new McpServer({
        name: "meta-ads-mcp",
        version,
      });
      registerAllTools(connectionServer);

      requestStorage.run(store, async () => {
        await connectionServer.connect(transport);
      });

      res.on("close", () => {
        console.log(`[SSE] Connection closed event triggered for session: ${transport.sessionId}`);
        const deleted = transports.delete(transport.sessionId);
        console.log(`[SSE] Deleted session: ${transport.sessionId} (existed: ${deleted}). Current Map size: ${transports.size}, remaining:`, Array.from(transports.keys()));
      });
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      console.log(`[POST] Received request for sessionId query: "${sessionId}" (type: ${typeof sessionId}). req.query:`, req.query);
      console.log(`[POST] Content-Type header:`, req.headers["content-type"]);
      console.log(`[POST] Request body parsed by express:`, JSON.stringify(req.body));
      console.log(`[POST] Active sessions in Map:`, Array.from(transports.keys()));
      
      const transport = transports.get(sessionId);
      if (!transport) {
        console.warn(`[POST] Session ID "${sessionId}" not found in Map! Returning 400.`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      console.log(`[POST] Found transport for session "${sessionId}". Processing message...`);
      const store = (transport as any)._store || new Map<string, string>();
      const adAccountId = req.headers["x-meta-ad-account-id"] as string;
      if (adAccountId && !store.has("adAccountId")) {
        store.set("adAccountId", adAccountId);
      }

      requestStorage.run(store, async () => {
        try {
          await transport.handlePostMessage(req, res, req.body);
        } catch (err) {
          console.error(`[POST] Error during handlePostMessage:`, err);
        }
      });
    });

    const listenPort = portEnv ? parseInt(portEnv) : 8080;
    app.listen(listenPort, "0.0.0.0", () => {
      console.log(`Meta Ads MCP Server running on port ${listenPort} over SSE`);
    });
  } else {
    const transport = new StdioServerTransport();
    const stdioServer = new McpServer({
      name: "meta-ads-mcp",
      version,
    });
    registerAllTools(stdioServer);
    await stdioServer.connect(transport);
    console.log("Meta Ads MCP Server running over stdio");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// ── Smithery Sandbox ──

export function createSandboxServer() {
  const sandbox = new McpServer({
    name: "meta-ads-mcp",
    version,
  });

  const mockConfig: AdsConfig = {
    accessToken: "",
    adAccountId: "",
    appId: "",
    appSecret: "",
    businessId: "",
    pixelId: "",
  };
  const mockClient = new AdsClient(mockConfig);

  registerCampaignTools(sandbox, mockClient);
  registerAdsetTools(sandbox, mockClient);
  registerAdTools(sandbox, mockClient);
  registerCreativeTools(sandbox, mockClient);
  registerImageTools(sandbox, mockClient);
  registerVideoTools(sandbox, mockClient);
  registerCanvasTools(sandbox, mockClient);
  registerAudienceTools(sandbox, mockClient);
  registerTargetingTools(sandbox, mockClient);
  registerInsightTools(sandbox, mockClient);
  registerLeadTools(sandbox, mockClient);
  registerCatalogTools(sandbox, mockClient);
  registerFeedTools(sandbox, mockClient);
  registerRuleTools(sandbox, mockClient);
  registerExperimentTools(sandbox, mockClient);
  registerConversionTools(sandbox, mockClient);
  registerBudgetTools(sandbox, mockClient);
  registerReachFrequencyTools(sandbox, mockClient);
  registerBrandSafetyTools(sandbox, mockClient);
  registerAccountTools(sandbox, mockClient);
  registerBusinessTools(sandbox, mockClient);
  registerAuthTools(sandbox, mockClient);
  registerAdLibraryTools(sandbox, mockClient);
  registerResources(sandbox, mockClient);
  registerPrompts(sandbox);

  return sandbox;
}
