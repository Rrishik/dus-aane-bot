// Worker → Apps Script actions (things only Apps Script can do: send mail
// from the bot account, read the bot's Gmail for /backfill, create Sheets).
//
// Apps Script's doPost can't read request headers, so the signature travels
// in the body: { action, ts, payload: "<json>", sig } with
//   sig = hex(HMAC-SHA256(INTERNAL_SECRET, ts + "." + action + "." + payload)).
import { hmacHex } from "./auth.js";

export class AppsScriptError extends Error {}

export async function callAppsScript(ctx, action, payload) {
  const { APPS_SCRIPT_URL, INTERNAL_SECRET } = ctx.env;
  if (!APPS_SCRIPT_URL || !INTERNAL_SECRET) throw new AppsScriptError("Apps Script bridge not configured");
  const ts = String(ctx.now());
  // Non-ASCII escaped so Apps Script's HMAC sees exactly these bytes.
  const payloadStr = JSON.stringify(payload || {}).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
  const sig = await hmacHex(INTERNAL_SECRET, ts + "." + action + "." + payloadStr);
  let res;
  try {
    res = await ctx.fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ts, payload: payloadStr, sig }),
      redirect: "follow"
    });
  } catch (e) {
    throw new AppsScriptError(action + ": network error: " + (e && e.message));
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok !== true) {
    throw new AppsScriptError(action + " failed: " + ((json && json.error) || "HTTP " + res.status));
  }
  return json;
}
