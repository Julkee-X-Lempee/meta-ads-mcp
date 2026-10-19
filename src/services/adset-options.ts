import { z } from "zod";
import type { AdsClient } from "./ads-client.js";

export const deliveryOptions = {
  destination_type: z.string().optional().describe("Conversion destination, e.g. WEBSITE, APP, MESSENGER, INSTAGRAM_DIRECT, WHATSAPP"),
  attribution_spec: z.array(z.object({
    event_type: z.enum(["CLICK_THROUGH", "VIEW_THROUGH", "ENGAGED_VIDEO_VIEW"]),
    window_days: z.number().int().positive(),
    weight: z.number().optional(),
  })).min(1).optional().describe("Attribution windows; Meta validates compatibility with the objective and optimization goal"),
  adset_schedule: z.array(z.object({
    start_minute: z.number().int().min(0).max(1439),
    end_minute: z.number().int().min(1).max(1440),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    timezone_type: z.enum(["USER", "ADVERTISER"]).optional(),
  })).min(1).optional().describe("Hourly delivery intervals (Sunday=0). Requires lifetime budgeting. Set timezone_type explicitly; Meta defaults to USER."),
  pacing_type: z.array(z.string()).optional().describe("Pacing settings. When a schedule is supplied, day_parting is required and is added if omitted."),
  validate_only: z.boolean().optional().describe("Validate with Meta without creating or updating the ad set (default false)"),
};

type DeliveryOptions = z.infer<z.ZodObject<typeof deliveryOptions>>;

export function buildDeliveryOptions(options: DeliveryOptions & {
  daily_budget?: string; lifetime_budget?: string; start_time?: string; end_time?: string;
}): Record<string, unknown> {
  const { daily_budget, lifetime_budget, start_time, end_time, adset_schedule, attribution_spec, destination_type, pacing_type, validate_only } = options;
  if (Number(daily_budget) > 0 && Number(lifetime_budget) > 0) {
    throw new Error("Choose daily_budget or lifetime_budget, not both.");
  }
  for (const [key, value] of [["start_time", start_time], ["end_time", end_time]]) {
    if (value && !Number.isFinite(Date.parse(value))) throw new Error(`${key} must be a valid date.`);
  }
  if (start_time && end_time && Date.parse(end_time) <= Date.parse(start_time)) {
    throw new Error("end_time must follow start_time.");
  }
  if (attribution_spec && new Set(attribution_spec.map((entry) => entry.event_type)).size !== attribution_spec.length) {
    throw new Error("attribution_spec must not repeat an event_type.");
  }
  if (adset_schedule) {
    if (Number(daily_budget) > 0) throw new Error("Hourly delivery requires lifetime budgeting, not daily_budget.");
    for (let i = 0; i < adset_schedule.length; i++) {
      const slot = adset_schedule[i];
      if (slot.start_minute >= slot.end_minute || new Set(slot.days).size !== slot.days.length) {
        throw new Error("adset_schedule contains an invalid interval or duplicate day.");
      }
      for (const earlier of adset_schedule.slice(0, i)) {
        if ((slot.timezone_type ?? "USER") === (earlier.timezone_type ?? "USER") &&
            slot.days.some((day) => earlier.days.includes(day)) &&
            slot.start_minute < earlier.end_minute && earlier.start_minute < slot.end_minute) {
          throw new Error("adset_schedule intervals overlap.");
        }
      }
    }
  }
  return {
    ...(destination_type !== undefined ? { destination_type } : {}),
    ...(attribution_spec !== undefined ? { attribution_spec } : {}),
    ...(adset_schedule !== undefined ? { adset_schedule } : {}),
    ...(adset_schedule ? { pacing_type: [...new Set([...(pacing_type ?? []), "day_parting"])] } : pacing_type !== undefined ? { pacing_type } : {}),
    ...(validate_only ? { execution_options: ["validate_only"] } : {}),
  };
}

export async function scopedListPath(client: AdsClient, edge: "ads" | "adsets", campaignId?: string, adsetId?: string, accountId?: string): Promise<string> {
  const scopeId = adsetId || campaignId;
  if (!scopeId) return `${client.accountPath(accountId)}/${edge}`;
  if (accountId || (campaignId && adsetId)) {
    const { data } = await client.get(`/${scopeId}`, { fields: adsetId ? "campaign_id,account_id" : "account_id" });
    const scope = data as { campaign_id?: string; account_id?: string };
    if (campaignId && adsetId && scope.campaign_id !== campaignId) throw new Error("adset_id does not belong to campaign_id.");
    if (accountId && scope.account_id !== accountId.replace(/^act_/, "")) throw new Error("The requested campaign or ad set does not belong to account_id.");
  }
  return `/${scopeId}/${edge}`;
}
