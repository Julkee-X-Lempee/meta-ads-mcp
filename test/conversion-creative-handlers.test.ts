import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdsClient } from "../src/services/ads-client.js";
import { registerConversionTools } from "../src/tools/conversions.js";
import { registerCreativeTools } from "../src/tools/creatives.js";

function capture() {
  const tools = new Map<string, { schema: z.ZodRawShape; handler: (args: any) => Promise<any> }>();
  const calls: Array<{ path: string; params?: Record<string, unknown> }> = [];
  const server = { tool(name: string, _description: string, schema: z.ZodRawShape, handler: (args: any) => Promise<any>) {
    tools.set(name, { schema, handler });
  } } as unknown as McpServer;
  const client = {
    pixelId: "pixel", accountPath: (id?: string) => `act_${id || "default"}`,
    async post(path: string, params?: Record<string, unknown>) {
      calls.push({ path, params });
      return { data: { success: true } };
    },
  } as unknown as AdsClient;
  registerConversionTools(server, client);
  registerCreativeTools(server, client);
  return { calls, async run(name: string, args: Record<string, unknown>) {
    const tool = tools.get(name)!;
    return tool.handler(z.object(tool.schema).parse(args));
  } };
}

test("conversion tools send parsed data arrays and test_event_code", async () => {
  const { run, calls } = capture();
  const events = [{ event_name: "Purchase", event_time: 123, action_source: "physical_store", user_data: {} }];
  await run("send_conversion_event", { events: JSON.stringify(events), test_event_code: "TEST123" });
  await run("send_offline_event", { event_set_id: "dataset", events: JSON.stringify(events) });
  assert.deepEqual(calls, [
    { path: "/pixel/events", params: { data: events, test_event_code: "TEST123" } },
    { path: "/dataset/events", params: { data: events } },
  ]);
});

test("invalid conversion JSON fails before any API call", async () => {
  const { run, calls } = capture();
  for (const events of ["not json", "{}", "[]", "[null]", "[[]]", "[1]", JSON.stringify(Array.from({ length: 1001 }, () => ({})))]) {
    assert.equal((await run("send_conversion_event", { events })).isError, true);
  }
  assert.equal(calls.length, 0);
});

test("creative controls are parsed and sent at the top level", async () => {
  const { run, calls } = capture();
  const destination_spec = { destination_type: "WEBSITE_AND_SHOP_OPT_OUT" };
  const wamo_whatsapp_identity_spec = { whatsapp_phone_number: "15550000000" };
  const degrees_of_freedom_spec = { creative_features_spec: { image_animation: { enroll_status: "OPT_OUT" } } };
  await run("create_creative", {
    name: "Example", object_story_spec: '{"page_id":"page"}', account_id: "other",
    destination_spec: JSON.stringify(destination_spec),
    wamo_whatsapp_identity_spec: JSON.stringify(wamo_whatsapp_identity_spec),
    degrees_of_freedom_spec: JSON.stringify(degrees_of_freedom_spec),
  });
  assert.deepEqual(calls[0], { path: "act_other/adcreatives", params: {
    name: "Example", object_story_spec: { page_id: "page" }, destination_spec,
    wamo_whatsapp_identity_spec, degrees_of_freedom_spec,
  } });
});

test("legacy nested WhatsApp identity migrates without leaking into object_story_spec", async () => {
  const { run, calls } = capture();
  await run("create_creative", { name: "Example", object_story_spec: '{"page_id":"page","wamo_whatsapp_identity_spec":{"wamo_whatsapp_identity_id":"identity"}}' });
  assert.deepEqual(calls[0].params?.object_story_spec, { page_id: "page" });
  assert.deepEqual(calls[0].params?.wamo_whatsapp_identity_spec, { wamo_whatsapp_identity_id: "identity" });
});

test("creative options reject malformed JSON before creating anything", async () => {
  const { run, calls } = capture();
  for (const options of [{ object_story_spec: "null" }, { destination_spec: "[]" }, { wamo_whatsapp_identity_spec: "broken" }, { degrees_of_freedom_spec: "false" }]) {
    assert.equal((await run("create_creative", { name: "Example", object_story_spec: '{"page_id":"page"}', ...options })).isError, true);
  }
  assert.equal(calls.length, 0);
});

test("dynamic creative supports Page identity and the same creative controls", async () => {
  const { run, calls } = capture();
  await run("create_dynamic_creative", { name: "Dynamic", asset_feed_spec: '{"images":[{"hash":"image"}]}', object_story_spec: '{"page_id":"page"}', destination_spec: '{"destination_type":"WEBSITE_AND_SHOP_OPT_OUT"}' });
  assert.deepEqual(calls[0].params, {
    name: "Dynamic", asset_feed_spec: { images: [{ hash: "image" }] }, object_story_spec: { page_id: "page" },
    destination_spec: { destination_type: "WEBSITE_AND_SHOP_OPT_OUT" },
  });
});
