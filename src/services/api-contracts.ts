export type BudgetScheduleParentType = "campaign" | "adset";

export function buildBudgetSchedulePath(
  parentId: string,
  _parentType: BudgetScheduleParentType
): string {
  if (!parentId) throw new Error("A campaign or ad set ID is required.");
  return `/${parentId}/budget_schedules`;
}

export function buildFacebookTokenExchangeParams(
  token: string,
  appId: string,
  appSecret: string
): URLSearchParams {
  if (!appId || !appSecret) {
    throw new Error(
      "META_APP_ID and META_APP_SECRET are required for token exchange."
    );
  }
  return new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: token,
  });
}

export function buildAsyncReportStatusPath(reportRunId: string): string {
  return `/${reportRunId}`;
}

export function buildAsyncReportResultsPath(reportRunId: string): string {
  return `/${reportRunId}/insights`;
}

export function parseJsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function buildConversionParams(events: string, testEventCode?: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(events);
  } catch {
    throw new Error("events must contain valid JSON.");
  }
  if (!Array.isArray(data) || data.length === 0 || data.length > 1000 || data.some((event) => !event || typeof event !== "object" || Array.isArray(event))) {
    throw new Error("events must be a JSON array containing 1 to 1000 event objects.");
  }
  return { data, ...(testEventCode ? { test_event_code: testEventCode } : {}) };
}
