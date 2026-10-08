// HMAC request signing between the Worker and Apps Script (both ways).
//
//   X-Dab-Timestamp: epoch ms
//   X-Dab-Signature: hex(HMAC-SHA256(secret, timestamp + "." + body))
//
// Apps Script produces the same value with
// Utilities.computeHmacSha256Signature(ts + "." + body, secret).
const enc = new TextEncoder();
export const MAX_SKEW_MS = 5 * 60 * 1000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signedHeaders(secret, body, now = Date.now()) {
  const ts = String(now);
  return { "X-Dab-Timestamp": ts, "X-Dab-Signature": await hmacHex(secret, ts + "." + body) };
}

// Returns { ok: true, body } or { ok: false, reason }. Reads the body once.
export async function verifySignedRequest(request, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: "not configured" };
  const ts = request.headers.get("X-Dab-Timestamp") || "";
  const sig = request.headers.get("X-Dab-Signature") || "";
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
  const body = await request.text();
  const expected = await hmacHex(secret, ts + "." + body);
  return constantTimeEqual(sig, expected) ? { ok: true, body } : { ok: false, reason: "bad signature" };
}
