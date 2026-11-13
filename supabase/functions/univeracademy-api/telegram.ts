import { fail } from "./fault.ts";

const encoder = new TextEncoder();

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Verification is NOT login: consume replayKey and issue a session atomically later.
export async function verifyTelegramInitData(
  raw: string,
  botToken: string,
  allowedAuthDate: { notBeforeSeconds: number; notAfterSeconds: number },
): Promise<{
  telegramUserId: number;
  firstName: string;
  lastName: string | null;
  authDate: number;
  replayKey: string;
}> {
  // No guessed freshness/clock-skew/TTL defaults. Only a trusted caller supplies this interval.
  if (typeof botToken !== "string" || !botToken || !allowedAuthDate ||
    !Number.isSafeInteger(allowedAuthDate.notBeforeSeconds) ||
    !Number.isSafeInteger(allowedAuthDate.notAfterSeconds) ||
    allowedAuthDate.notBeforeSeconds < 0 ||
    allowedAuthDate.notBeforeSeconds > allowedAuthDate.notAfterSeconds) {
    fail("SERVICE_UNAVAILABLE", 503);
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16384 ||
    /%(?![0-9a-fA-F]{2})/.test(raw)) fail("INIT_DATA_INVALID", 401);

  const fields = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [key] of fields) {
    if (!key || seen.has(key)) fail("INIT_DATA_INVALID", 401);
    seen.add(key);
  }
  const hash = fields.get("hash");
  if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) fail("INIT_DATA_INVALID", 401);
  fields.delete("hash");
  const checkString = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const rootKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", rootKey, encoder.encode(botToken));
  const signingKey = await crypto.subtle.importKey("raw", secret,
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(hash.match(/../g)!, (pair) => parseInt(pair, 16));
  if (!await crypto.subtle.verify("HMAC", signingKey, signature, encoder.encode(checkString))) {
    fail("INIT_DATA_INVALID", 401);
  }

  const authDateText = fields.get("auth_date");
  if (!authDateText || !/^\d+$/.test(authDateText)) fail("INIT_DATA_INVALID", 401);
  const authDate = Number(authDateText);
  if (!Number.isSafeInteger(authDate) || authDate > allowedAuthDate.notAfterSeconds) {
    fail("INIT_DATA_INVALID", 401);
  }
  if (authDate < allowedAuthDate.notBeforeSeconds) fail("INIT_DATA_EXPIRED", 401);

  let user: unknown;
  try { user = JSON.parse(fields.get("user") ?? "null"); }
  catch { fail("INIT_DATA_INVALID", 401); }
  if (!user || typeof user !== "object" || Array.isArray(user)) fail("INIT_DATA_INVALID", 401);
  const identity = user as Record<string, unknown>;
  if (!Number.isSafeInteger(identity.id) || (identity.id as number) <= 0 ||
    typeof identity.first_name !== "string" ||
    (identity.last_name !== undefined && typeof identity.last_name !== "string")) {
    fail("INIT_DATA_INVALID", 401);
  }
  return {
    telegramUserId: identity.id as number,
    firstName: identity.first_name,
    lastName: identity.last_name as string | undefined ?? null,
    authDate,
    replayKey: hash.toLowerCase(),
  };
}
