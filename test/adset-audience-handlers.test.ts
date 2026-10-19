import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdsClient } from "../src/services/ads-client.js";
import { registerAdsetTools } from "../src/tools/adsets.js";
import { registerAdTools } from "../src/tools/ads.js";
import { registerAudienceTools } from "../src/tools/audiences.js";

function capture(scope = { campaign_id: "campaign", account_id: "123" }) {
  const tools = new Map<string, { schema: z.ZodRawShape; handler: (args: any) => Promise<any> }>();
  const calls: Array<{ method: string; path: string; params?: Record<string, unknown> }> = [];
  const server = { tool(name: string, _description: string, schema: z.ZodRawShape, handler: (args: any) => Promise<any>) {
    tools.set(name, { schema, handler });
  } } as unknown as McpServer;
  const client = {
    accountPath: (id = "123") => `/act_${id.replace(/^act_/, "")}`,
    async get(path: string, params?: Record<string, unknown>) { calls.push({ method: "GET", path, params }); return { data: scope }; },
    async post(path: string, params?: Record<string, unknown>) { calls.push({ method: "POST", path, params }); return { data: { success: true } }; },
  } as unknown as AdsClient;
  registerAdsetTools(server, client);
  registerAdTools(server, client);
  registerAudienceTools(server, client);
  return { calls, async run(name: string, args: Record<string, unknown>) {
    const tool = tools.get(name)!;
    return tool.handler(z.object(tool.schema).parse(args));
  } };
}

const create = { name: "Launch", campaign_id: "campaign", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: '{"geo_locations":{"countries":["DK"]}}' };
const schedule = [{ start_minute: 540, end_minute: 1020, days: [1, 2], timezone_type: "ADVERTISER" }];

test("ad set creation forwards bid cap and independent DSA fields", async () => {
  const { run, calls } = capture();
  await run("create_adset", { ...create, bid_strategy: "COST_CAP", bid_amount: "150", dsa_beneficiary: "Beneficiary", dsa_payor: "Payer" });
  assert.equal(calls[0].params?.bid_amount, "150");
  assert.equal(calls[0].params?.dsa_beneficiary, "Beneficiary");
  assert.equal(calls[0].params?.dsa_payor, "Payer");
  assert.equal(calls[0].params?.status, "PAUSED");
  await run("update_adset", { adset_id: "set", dsa_beneficiary: "New beneficiary" });
  assert.deepEqual(calls[1].params, { dsa_beneficiary: "New beneficiary" });
});

test("ad and ad set lists use official scoped edges with pagination", async () => {
  const { run, calls } = capture();
  await run("list_ads", {});
  await run("list_ads", { campaign_id: "campaign", after: "next", status: "ACTIVE" });
  await run("list_ads", { adset_id: "set", fields: "id" });
  await run("list_adsets", { campaign_id: "campaign" });
  assert.deepEqual(calls.map((call) => call.path), ["/act_123/ads", "/campaign/ads", "/set/ads", "/campaign/adsets"]);
  assert.deepEqual(calls[1].params, { limit: 25, after: "next", effective_status: '["ACTIVE"]' });
  assert.ok(calls.every(({ params }) => params?.campaign_id === undefined && params?.adset_id === undefined));
});

test("combined scopes validate parent and explicit account before listing", async () => {
  const { run, calls } = capture();
  await run("list_ads", { campaign_id: "campaign", adset_id: "set", account_id: "act_123" });
  assert.deepEqual(calls.map((call) => call.path), ["/set", "/set/ads"]);
  assert.equal((await run("list_ads", { campaign_id: "other", adset_id: "set" })).isError, true);
  assert.equal((await run("list_adsets", { campaign_id: "campaign", account_id: "456" })).isError, true);
  assert.equal(calls.filter((call) => call.path.endsWith("/ads")).length, 1);
});

test("launch options validate remotely without changing defaults and preserve pacing options", async () => {
  const { run, calls } = capture();
  const preview = await run("create_adset", { ...create, destination_type: "WEBSITE", attribution_spec: [{ event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 }], adset_schedule: schedule, lifetime_budget: "10000", pacing_type: ["standard"], validate_only: true });
  assert.equal(JSON.parse(preview.content[0].text)._validationOnly, true);
  assert.deepEqual(calls[0].params?.execution_options, ["validate_only"]);
  assert.deepEqual(calls[0].params?.pacing_type, ["standard", "day_parting"]);
  assert.deepEqual(calls[0].params?.adset_schedule, schedule);
  await run("update_adset", { adset_id: "set", adset_schedule: schedule, validate_only: true });
  assert.deepEqual(calls[1].params, { adset_schedule: schedule, pacing_type: ["day_parting"], execution_options: ["validate_only"] });
  await run("create_adset", create);
  assert.equal(calls[2].params?.execution_options, undefined);
});

test("invalid launch constraints fail before network requests", async () => {
  const { run, calls } = capture();
  for (const extra of [
    { targeting: "[]" },
    { targeting: "invalid" },
    { promoted_object: "null" },
    { daily_budget: "100", lifetime_budget: "1000" },
    { start_time: "2026-12-02T00:00:00Z", end_time: "2026-12-01T00:00:00Z" },
    { start_time: "not-a-date" },
    { adset_schedule: schedule, daily_budget: "100" },
    { adset_schedule: [{ ...schedule[0], end_minute: 500 }] },
    { adset_schedule: [schedule[0], schedule[0]] },
    { attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }, { event_type: "CLICK_THROUGH", window_days: 7 }] },
  ]) assert.equal((await run("create_adset", { ...create, ...extra })).isError, true);
  assert.equal(calls.length, 0);
});

test("rule audiences forward validated rules without an unsupported dry-run claim", async () => {
  const { run, calls } = capture();
  const rule = { inclusions: { operator: "or", rules: [{ event_sources: [{ id: "pixel", type: "pixel" }], retention_seconds: 86400 }] } };
  await run("create_custom_audience", { name: "Visitors", subtype: "WEBSITE", rule: JSON.stringify(rule), pixel_id: "pixel", retention_days: 30 });
  assert.deepEqual(calls[0].params, { name: "Visitors", subtype: "WEBSITE", rule: JSON.stringify(rule), pixel_id: "pixel", retention_days: 30 });
  for (const invalid of ["null", "[]", "{}", "invalid"]) {
    assert.equal((await run("create_custom_audience", { name: "Invalid", subtype: "ENGAGEMENT", rule: invalid })).isError, true);
  }
  assert.equal(calls.length, 1);
});
