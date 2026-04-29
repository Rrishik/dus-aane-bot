// ─── Forwarding-address auto-confirm ─────────────────────────────────────────
//
// When a tenant adds our bot inbox as a forwarding destination in Gmail,
// Google emails a confirmation link/code to that destination (i.e. our bot
// inbox). The tenant is then blocked until someone clicks that link.
//
// Flow we support:
//   1. Setup email (Onboarding.js) embeds a "Verify forwarding address" button
//      pointing at this script's web-app URL with a signed token in the query
//      string (`?action=verify&t=<chatId>&sig=<hmac>`).
//   2. User clicks → Gmail sends the click via a normal browser GET to
//      doGet() (Code.js) → handleVerifyForwardingClick() runs.
//   3. We scan the bot inbox for unread Gmail-forwarding-confirmation mails,
//      extract the `vf-...` confirmation URL, fetch it (which is what Gmail
//      considers "click the link"), then return an HTML status page.
//
// This is a click-driven, idempotent endpoint. No background polling, no
// time-based triggers — runs only when a user opts in by clicking.

// Subject prefix Gmail uses for the forwarding confirmation mail (locale-
// independent enough; matched as a substring).
var FORWARDING_CONFIRM_SUBJECT = "Gmail Forwarding Confirmation";
var FORWARDING_CONFIRM_FROM = "forwarding-noreply@google.com";
// Confirmation URLs look like:
//   https://mail-settings.google.com/mail/vf-%5B<id>%5D-<token>
// Pattern is permissive on purpose: Google has tweaked the URL shape over the
// years and we only need a single-shot fetch — false positives self-correct
// because the URL is single-use and idempotent.
var FORWARDING_CONFIRM_URL_RE = /https:\/\/mail-settings\.google\.com\/mail\/vf-[^\s"'<>)]+/;

// Property key for the HMAC secret used to sign verify tokens. Generated
// lazily on first use; never logged.
var VERIFY_TOKEN_SECRET_KEY = "verify_token_secret";
// Token TTL — long enough that the user can finish setup at their own pace,
// short enough that an old leaked email link expires. 7 days.
var VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Get (and lazily generate) the HMAC secret used to sign verify tokens.
 * Stored in ScriptProperties — survives redeploys, never leaves the script.
 */
function _getVerifySecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty(VERIFY_TOKEN_SECRET_KEY);
  if (!secret) {
    var bytes = Utilities.getUuid() + "|" + Utilities.getUuid();
    secret = Utilities.base64EncodeWebSafe(bytes);
    props.setProperty(VERIFY_TOKEN_SECRET_KEY, secret);
  }
  return secret;
}

/**
 * Compute a URL-safe HMAC signature for the given payload. Pure-ish — depends
 * only on the per-script secret (cached in ScriptProperties).
 *
 * Format choice: base64-web-safe of HMAC-SHA256, no padding. ~43 chars.
 */
function signVerifyToken(chatId, issuedAtMs) {
  var secret = _getVerifySecret();
  var payload = String(chatId) + "." + String(issuedAtMs);
  var raw = Utilities.computeHmacSha256Signature(payload, secret);
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, "");
}

/**
 * Constant-time string compare. Apps Script's `==` is fine for HMACs that
 * came from our own signing function (no remote attacker controls timing in
 * a meaningful way for an HTTPS endpoint), but we do this anyway as defense
 * in depth and so the code reads correctly.
 */
function _constantTimeEquals(a, b) {
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a token returned from the email link. Returns true iff the signature
 * matches AND the issued-at timestamp is within VERIFY_TOKEN_TTL_MS.
 */
function verifyVerifyToken(chatId, issuedAtMs, sig, nowMs) {
  if (!chatId || !issuedAtMs || !sig) return false;
  var iat = Number(issuedAtMs);
  if (!isFinite(iat)) return false;
  var now = nowMs == null ? Date.now() : nowMs;
  if (now - iat > VERIFY_TOKEN_TTL_MS) return false;
  if (iat - now > 60 * 1000) return false; // small future-skew tolerance
  var expected = signVerifyToken(chatId, iat);
  return _constantTimeEquals(expected, String(sig));
}

/**
 * Build the signed verify URL embedded in the setup email's "Verify
 * forwarding address" button. webAppUrl should be the published /exec URL
 * of this Apps Script project.
 */
function buildVerifyForwardingUrl(webAppUrl, chatId, nowMs) {
  var iat = nowMs == null ? Date.now() : nowMs;
  var sig = signVerifyToken(chatId, iat);
  var qs =
    "action=verify_forwarding" +
    "&t=" +
    encodeURIComponent(String(chatId)) +
    "&iat=" +
    encodeURIComponent(String(iat)) +
    "&sig=" +
    encodeURIComponent(sig);
  // Append `?` or `&` correctly — published Apps Script URLs already have no
  // query string, but be defensive in case a deployer routes through a proxy
  // that injects one.
  var sep = webAppUrl.indexOf("?") === -1 ? "?" : "&";
  return webAppUrl + sep + qs;
}

/**
 * Extract the `vf-...` confirmation URL from the body of a forwarding-
 * confirmation mail. Returns null if the body doesn't contain one.
 *
 * Pure helper — accepts the raw body text so unit tests can feed in fixtures.
 */
function extractForwardingConfirmUrl(body) {
  if (!body) return null;
  var m = String(body).match(FORWARDING_CONFIRM_URL_RE);
  return m ? m[0] : null;
}

/**
 * Scan the bot inbox for unread forwarding-confirmation mails and click the
 * `vf-...` link in each. Returns a small report:
 *   { confirmed: number, failed: number, addresses: string[] }
 *
 * `addresses` is the list of forwarding addresses we attempted to confirm
 * (parsed from the subject; useful in the response page so users can see
 * which address got verified).
 *
 * Idempotent — re-running over the same threads simply re-fetches a single-
 * use URL that Google now treats as a no-op. We mark threads as read so we
 * don't keep noticing them.
 */
function confirmForwardingAddresses() {
  var query =
    "from:" + FORWARDING_CONFIRM_FROM + ' subject:"' + FORWARDING_CONFIRM_SUBJECT + '" is:unread newer_than:14d';
  var threads = GmailApp.search(query, 0, 25);
  var confirmed = 0;
  var failed = 0;
  var addresses = [];

  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var msg = msgs[j];
      var subject = msg.getSubject() || "";
      // Subject format: "<email> has requested to automatically forward mail
      // to your email address (#NNNN)" or "Gmail Forwarding Confirmation -
      // Receive Mail from <email>". Pull the first email-shaped token.
      var addrMatch = subject.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
      if (addrMatch) addresses.push(addrMatch[0]);

      var body = msg.getPlainBody() || msg.getBody() || "";
      var url = extractForwardingConfirmUrl(body);
      if (!url) {
        failed++;
        continue;
      }
      try {
        var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
        var code = resp.getResponseCode();
        if (code >= 200 && code < 400) {
          confirmed++;
        } else {
          console.warn("[confirmForwardingAddresses] non-2xx from confirm URL: " + code);
          failed++;
        }
      } catch (e) {
        console.error("[confirmForwardingAddresses] fetch failed: " + e.message);
        failed++;
      }
    }
    try {
      threads[i].markRead();
    } catch (e) {
      // markRead requires gmail.modify; if scope missing this throws but we
      // still confirmed the URL — non-fatal.
    }
  }
  return { confirmed: confirmed, failed: failed, addresses: addresses };
}

/**
 * doGet handler for `?action=verify_forwarding&t=<chatId>&iat=<ms>&sig=<hmac>`.
 * Validates the signature, runs confirmForwardingAddresses(), and returns an
 * HTML status page. Pure-ish wrapper that produces the response body for the
 * web-app dispatch in Code.js (`doGet`).
 */
function handleVerifyForwardingClick(params) {
  var chatId = params.t;
  var iat = params.iat;
  var sig = params.sig;
  if (!verifyVerifyToken(chatId, iat, sig)) {
    return _verifyResponseHtml({
      ok: false,
      title: "Link expired or invalid",
      body: "This verification link is no longer valid. Open Telegram and send /setup to get a fresh link."
    });
  }
  try {
    var result = confirmForwardingAddresses();
    if (result.confirmed > 0) {
      var addrText = result.addresses.length > 0 ? " for " + result.addresses.map(_escHtml).join(", ") : "";
      // Notify Telegram side too so the user gets confirmation across channels.
      try {
        sendTelegramMessage(
          Number(chatId),
          "✅ Forwarding address verified" +
            (result.addresses.length ? " for `" + result.addresses[0] + "`" : "") +
            ". Now create the Gmail filter from the same email — that's the last step.",
          { parse_mode: "Markdown" }
        );
      } catch (e) {
        console.warn("[handleVerifyForwardingClick] telegram notify failed: " + e.message);
      }
      return _verifyResponseHtml({
        ok: true,
        title: "Forwarding address verified",
        body:
          "We confirmed " +
          result.confirmed +
          " pending forwarding " +
          (result.confirmed === 1 ? "address" : "addresses") +
          addrText +
          ". You can now go back to the setup email and create the filter — that's the last step."
      });
    }
    return _verifyResponseHtml({
      ok: false,
      title: "No pending confirmation found",
      body:
        "We didn't find a pending Gmail forwarding-confirmation email. Make sure you completed step 1 (Forwarding settings &rarr; Add a forwarding address &rarr; <code>" +
        _escHtml(BOT_INBOX_EMAIL) +
        "</code> &rarr; Next), wait ~30 seconds, then click the verify button again."
    });
  } catch (e) {
    console.error("[handleVerifyForwardingClick] error: " + e.message);
    return _verifyResponseHtml({
      ok: false,
      title: "Something went wrong",
      body: "We hit an error verifying your forwarding address. Try again in a minute, or send /setup on Telegram for a fresh link."
    });
  }
}

/**
 * Wrap a status payload in a small self-contained HTML page. Internal — kept
 * out of the public API surface but exported in test loaders for snapshotting.
 */
function _verifyResponseHtml(opts) {
  var color = opts.ok ? "#137333" : "#c5221f";
  var icon = opts.ok ? "&#10003;" : "&#9888;";
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" +
    _escHtml(opts.title) +
    " &middot; Dus Aane Bot</title>" +
    "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7f8;margin:0;padding:48px 16px;color:#222}" +
    ".card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)}" +
    ".icon{font-size:42px;color:" +
    color +
    "}" +
    "h1{font-size:22px;margin:8px 0 12px}" +
    "p{font-size:15px;line-height:1.55;color:#444}" +
    "code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:13px}</style>" +
    '</head><body><div class="card">' +
    '<div class="icon">' +
    icon +
    "</div>" +
    "<h1>" +
    _escHtml(opts.title) +
    "</h1>" +
    "<p>" +
    opts.body +
    "</p>" +
    "</div></body></html>"
  );
}
