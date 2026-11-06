// Dice addition (not in upstream mikusnuz/meta-ads-mcp).
//
// Write tools: a small, fixed set of changes to Meta ad accounts, each with guardrails enforced
// here in the server so they hold no matter which client calls the tool. Same rules as the
// changes_* tools in Dice's google-ads-mcp fork. Named changes_meta_* because the Orchestrator's
// Panostaja chat offers both servers' tools to one model, which needs unique names (Google Ads
// already has changes_set_status); the changes_ prefix is what makes the chat apply on approval.
//
// - Every tool is a dry run unless called with validate_only=false. A dry run sends the change
//   to Meta with execution_options=["validate_only"], so Meta checks it fully but applies nothing.
// - Guardrail, on unless the caller passes guardrails=false (the autopilot never does; Dice's
//   operator chat does, since a person approves every change there): budget and bid changes are
//   capped at META_ADS_MCP_MAX_CHANGE_PCT (default 30) percent per call, up or down, and refused
//   when the current value isn't set.
// - Nothing is ever deleted or archived; statuses can only be ACTIVE or PAUSED.
// - Only daily budgets are changed, and only where the budget lives: on the campaign when it uses
//   campaign budget (CBO), on the ad set otherwise. Lifetime budgets are refused.
// - Bids are changed only on ad sets that already use a bid cap or cost cap; the bid strategy
//   itself is never switched.
// - Every object must belong to the ad account pinned for the session (X-Meta-Ad-Account-Id
//   header, or META_AD_ACCOUNT_ID): the token sees every client's accounts, and an object ID
//   alone would reach any of them.
// - Every result reports the value before and after, and every applied change is logged.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdsClient } from "../services/ads-client.js";

const BID_STRATEGIES_WITH_AMOUNT = new Set(["LOWEST_COST_WITH_BID_CAP", "COST_CAP"]);
// Meta stores money in the currency's minor unit, except for these currencies, which have none
// (Meta Marketing API, "Currencies": offset 1).
const NO_MINOR_UNIT = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);

class Refused extends Error {}

function maxChangePct(): number {
  const value = Number(process.env.META_ADS_MCP_MAX_CHANGE_PCT || "30");
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function checkChange(before: number, after: number, what: string, guardrails = true): number | null {
  if (!(after > 0)) throw new Refused(`Refused: ${what} must be greater than zero.`);
  if (!(before > 0)) {
    if (!guardrails) return null;
    throw new Refused(`Refused: the current ${what} is not set, so the change can't be limited. Change it in Meta Ads Manager directly.`);
  }
  const pct = ((after - before) / before) * 100;
  // rounded: 30.00 -> 39.00 is +30 % exactly, not 30.0000000000004 %
  if (guardrails && Math.round(Math.abs(pct) * 1e6) / 1e6 > maxChangePct()) {
    throw new Refused(
      `Refused: ${what} change of ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% exceeds the ${maxChangePct()}% limit per change ` +
      `(${before} -> ${after}). Make smaller steps.`
    );
  }
  return Math.round(pct * 10) / 10;
}

function ok(validateOnly: boolean, fields: Record<string, unknown>) {
  const result = { validate_only: validateOnly, applied: !validateOnly, ...fields };
  if (!validateOnly) console.log(`[changes] APPLIED ${JSON.stringify(result)}`);
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: error instanceof Refused ? message : `Failed: ${message}` }], isError: true };
}

async function readOwned(client: AdsClient, id: string, fields: string): Promise<Record<string, any>> {
  const accountId = client.pinnedAccountId;
  const { data } = await client.get(`/${id}`, { fields: `account_id,${fields}` });
  const row = data as Record<string, any>;
  if (String(row.account_id || "").replace(/^act_/, "") !== accountId) {
    throw new Refused(`Refused: ${id} does not belong to the session's ad account act_${accountId}.`);
  }
  return row;
}

async function minorUnits(client: AdsClient): Promise<{ currency: string; factor: number }> {
  const { data } = await client.get(`/act_${client.pinnedAccountId}`, { fields: "currency" });
  const currency = String((data as Record<string, any>).currency || "");
  return { currency, factor: NO_MINOR_UNIT.has(currency) ? 1 : 100 };
}

async function write(client: AdsClient, id: string, params: Record<string, unknown>, validateOnly: boolean): Promise<void> {
  await client.post(`/${id}`, validateOnly ? { ...params, execution_options: ["validate_only"] } : params);
}

const validateOnlyArg = z.boolean().optional().default(true)
  .describe("true (default) = Meta checks the change but nothing is applied. false = apply it.");
const guardrailsArg = z.boolean().optional().default(true)
  .describe("true (default) = Dice's safety limits apply. Leave as is.");

export function registerChangeTools(server: McpServer, client: AdsClient): void {
  // ─── changes_meta_update_budget ─────────────────────────────────
  server.tool(
    "changes_meta_update_budget",
    "Sets the daily budget of a campaign (campaign budget / CBO) or an ad set, in the account's currency " +
      "(e.g. 45.0 = 45 EUR/day). Dry run unless validate_only is false. Refused if the change is bigger than " +
      "the per-change limit (default 30%), if the object uses a lifetime budget, or if the budget lives on the " +
      "other level (ad sets of a CBO campaign have no budget of their own).",
    {
      level: z.enum(["campaign", "adset"]).describe("campaign or adset"),
      object_id: z.string().describe("Campaign or ad set ID"),
      new_daily_budget: z.number().describe("New daily budget in account currency, e.g. 45.0"),
      validate_only: validateOnlyArg,
      guardrails: guardrailsArg,
    },
    async ({ level, object_id, new_daily_budget, validate_only, guardrails }) => {
      try {
        const row = await readOwned(client, object_id, level === "adset" ? "name,daily_budget,lifetime_budget,campaign_id" : "name,daily_budget,lifetime_budget");
        if (Number(row.lifetime_budget || 0) > 0) {
          throw new Refused(`Refused: this ${level} uses a lifetime budget; only daily budgets are changed here.`);
        }
        if (!(Number(row.daily_budget || 0) > 0)) {
          throw new Refused(level === "adset"
            ? `Refused: this ad set has no budget of its own; its campaign (${row.campaign_id}) uses campaign budget. Change the campaign instead.`
            : "Refused: this campaign has no campaign budget; its ad sets have their own budgets. Change an ad set instead.");
        }
        const { currency, factor } = await minorUnits(client);
        const before = Number(row.daily_budget) / factor;
        const pct = checkChange(before, new_daily_budget, "daily budget", guardrails);
        await write(client, object_id, { daily_budget: String(Math.round(new_daily_budget * factor)) }, validate_only);
        return ok(validate_only, {
          level, object_id, name: row.name, currency,
          daily_budget_before: before, daily_budget_after: new_daily_budget, change_pct: pct,
        });
      } catch (error) {
        return failed(error);
      }
    }
  );

  // ─── changes_meta_set_status ────────────────────────────────────
  server.tool(
    "changes_meta_set_status",
    "Pauses or activates a campaign, ad set or ad. Never deletes or archives anything. Dry run unless validate_only is false.",
    {
      level: z.enum(["campaign", "adset", "ad"]).describe("campaign, adset or ad"),
      object_id: z.string().describe("Campaign, ad set or ad ID"),
      status: z.enum(["ACTIVE", "PAUSED"]).describe("ACTIVE or PAUSED"),
      validate_only: validateOnlyArg,
    },
    async ({ level, object_id, status, validate_only }) => {
      try {
        // Campaigns have no campaign_id field; ad sets and ads report theirs (follow-ups measure the campaign).
        const row = await readOwned(client, object_id, level === "campaign" ? "name,status,effective_status" : "name,status,effective_status,campaign_id");
        if (row.status === "DELETED" || row.status === "ARCHIVED") {
          throw new Refused(`Refused: this ${level} is ${row.status}; it can't be changed here.`);
        }
        await write(client, object_id, { status }, validate_only);
        return ok(validate_only, {
          level, object_id, name: row.name, campaign_id: level === "campaign" ? object_id : row.campaign_id,
          status_before: row.status, status_after: status, effective_status_before: row.effective_status,
        });
      } catch (error) {
        return failed(error);
      }
    }
  );

  // ─── changes_meta_update_bid ────────────────────────────────────
  server.tool(
    "changes_meta_update_bid",
    "Sets an ad set's bid amount (its bid cap or cost cap), in the account's currency. Only for ad sets that " +
      "already use LOWEST_COST_WITH_BID_CAP or COST_CAP with an amount set; the bid strategy is never switched. " +
      "Dry run unless validate_only is false. Refused if the change is bigger than the per-change limit (default 30%).",
    {
      adset_id: z.string().describe("Ad set ID"),
      new_bid_amount: z.number().describe("New bid amount in account currency, e.g. 12.5"),
      validate_only: validateOnlyArg,
      guardrails: guardrailsArg,
    },
    async ({ adset_id, new_bid_amount, validate_only, guardrails }) => {
      try {
        const row = await readOwned(client, adset_id, "name,bid_strategy,bid_amount,campaign{bid_strategy}");
        // Under campaign budget the strategy is set on the campaign; the amount still lives on the ad set.
        const strategy = String(row.bid_strategy || row.campaign?.bid_strategy || "");
        if (!BID_STRATEGIES_WITH_AMOUNT.has(strategy)) {
          throw new Refused(`Refused: this ad set's bid strategy is ${strategy || "not set"}; only bid cap and cost cap amounts are changed here.`);
        }
        const { currency, factor } = await minorUnits(client);
        const before = Number(row.bid_amount || 0) / factor;
        const pct = checkChange(before, new_bid_amount, "bid amount", guardrails);
        await write(client, adset_id, { bid_amount: String(Math.round(new_bid_amount * factor)) }, validate_only);
        return ok(validate_only, {
          adset_id, name: row.name, currency, bid_strategy: strategy,
          bid_amount_before: before, bid_amount_after: new_bid_amount, change_pct: pct,
        });
      } catch (error) {
        return failed(error);
      }
    }
  );
}
