// Cloudflare Access sits in front of the admin dashboard; this re-checks its
// signed token on every request, so a misconfigured Access policy (or a
// workers.dev URL) can't expose anything. Fails closed when unconfigured.
//
// env: ACCESS_TEAM_DOMAIN ("<team>.cloudflareaccess.com"), ACCESS_AUD (the
// application's AUD tag), ADMIN_EMAILS (comma-separated allowlist).

const CERTS_TTL_MS = 10 * 60 * 1000;
const SKEW_S = 60;
let certsCache = { url: null, at: 0, keys: [] };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodePart(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

function tokenFrom(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

async function signingKeys(teamDomain, fetchImpl, now) {
  const url = "https://" + teamDomain + "/cdn-cgi/access/certs";
  if (certsCache.url === url && now - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error("certs " + res.status);
  const body = await res.json();
  certsCache = { url, at: now, keys: body.keys || [] };
  return certsCache.keys;
}

export function resetAccessCache() {
  certsCache = { url: null, at: 0, keys: [] };
}

// → { ok: true, email } or { ok: false, reason }.
export async function verifyAccess(request, env, { fetchImpl = (...a) => fetch(...a), now = Date.now() } = {}) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").trim();
  const aud = String(env.ACCESS_AUD || "").trim();
  const allowed = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!team || !aud || !allowed.length) return { ok: false, reason: "not configured" };

  const token = tokenFrom(request);
  if (!token) return { ok: false, reason: "no token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  let header;
  let claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch (_) {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "bad alg" };

  let keys;
  try {
    keys = await signingKeys(team, fetchImpl, now);
  } catch (_) {
    return { ok: false, reason: "certs unavailable" };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify"
    ]);
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
  } catch (_) {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  const nowS = Math.floor(now / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return { ok: false, reason: "wrong audience" };
  if (claims.iss !== "https://" + team) return { ok: false, reason: "wrong issuer" };
  if (!(claims.exp > nowS - SKEW_S)) return { ok: false, reason: "expired" };
  if (claims.nbf && claims.nbf > nowS + SKEW_S) return { ok: false, reason: "not yet valid" };
  const email = String(claims.email || "").toLowerCase();
  if (!allowed.includes(email)) return { ok: false, reason: "not an admin" };
  return { ok: true, email };
}
