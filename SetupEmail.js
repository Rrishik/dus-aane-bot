// The auto-forwarding setup email (sent on the Worker's behalf) and the
// Gmail filter it asks users to create.

/**
 * Gmail filter query: `from:(<verified senders>) -(subject:OTP OR ...)`.
 *
 * The sender allowlist is the primary filter — only verified bank
 * transaction senders match. The subject exclusion (FILTER_OTP_SUBJECTS) is
 * narrower than server-side IGNORE_SUBJECTS: it only blocks OTP / auth-code
 * mail from being auto-forwarded; those must stay in the user's inbox.
 * Other noise (statements, marketing, login alerts) is dropped server-side
 * after the bot receives the mail, keeping the user-pasted query short.
 */
function buildGmailFilterQuery() {
  var senders = "from:(" + TRANSACTION_SENDERS.join(" OR ") + ")";
  var excludes = FILTER_OTP_SUBJECTS.map(function (s) {
    return "subject:" + s;
  }).join(" OR ");
  return senders + " -(" + excludes + ")";
}

function _escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildGmailFilterPrefillUrl(query) {
  return "https://mail.google.com/mail/#search/" + encodeURIComponent(query);
}

/**
 * Web-app URL for the verify-forwarding click handler.
 *
 * Resolution order:
 *   1. ScriptProperty `WEBAPP_URL` (set after publishing; survives redeploys).
 *   2. ScriptApp.getService().getUrl() fallback (head/dev URL).
 * Returns null if neither is available; callers must hide the verify button.
 */
function getWebAppUrl() {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty("WEBAPP_URL");
  if (stored) return stored;
  try {
    return ScriptApp.getService().getUrl();
  } catch (e) {
    return null;
  }
}

/**
 * Build the auto-forwarding setup email body. Steps 1+2+3 since they all
 * serve the same goal (auto-forward future bank emails) — manually
 * forwarding one email needs none of these.
 *
 * `verifyUrl` may be null if the web-app deployment isn't published; in
 * that case we render a manual-instruction fallback.
 */
function buildSetupEmailHtml(query, botInboxEmail, demoUrl, guideUrl, verifyUrl) {
  var q = _escHtml(query);
  var bot = _escHtml(botInboxEmail);
  var demo = _escHtml(demoUrl);
  var guide = _escHtml(guideUrl);
  var prefillUrl = _escHtml(buildGmailFilterPrefillUrl(query));
  var verify = verifyUrl ? _escHtml(verifyUrl) : null;
  var verifyBlock = verify
    ? '<p style="margin:0 0 8px">After clicking <b>Next</b> in step 1, Gmail emails a confirmation code to our inbox. Tap below — we\'ll auto-confirm it.</p>' +
      '<p style="margin:0 0 4px">' +
      '<a href="' +
      verify +
      '" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;background:#137333;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">\u2705 Verify forwarding address</a>' +
      "</p>" +
      '<p style="margin:0;color:#666;font-size:13px">If you tap too early, wait ~30 seconds and tap again — the link is reusable for 7 days.</p>'
    : "<p style=\"margin:0;color:#666;font-size:14px\">Wait for the confirmation email in our inbox; we'll handle the rest. (Verify-button auto-link unavailable — contact support if this step doesn't complete within a minute.)</p>";

  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px">' +
    '<h2 style="margin:0 0 8px">Auto-forward bank emails (~1 min)</h2>' +
    "<p>Skip manual forwarding. One Gmail filter routes only verified bank transaction alerts to <code>" +
    bot +
    "</code> — no OTPs, statements, or marketing.</p>" +
    '<div style="background:#fff8e1;border-left:4px solid #f9ab00;padding:10px 14px;border-radius:4px;margin:16px 0;font-size:14px">' +
    "<b>\uD83D\uDDA5\uFE0F Open this email on a desktop browser.</b> Gmail's forwarding settings aren't available in the mobile app or mobile web." +
    "</div>" +
    '<h3 style="margin:24px 0 8px">Step 1 &middot; Add the forwarding address</h3>' +
    '<p style="margin:0 0 8px">Click below, then in the Gmail tab: <b>Add a forwarding address</b> &rarr; paste <code>' +
    bot +
    "</code> &rarr; <b>Next</b> &rarr; <b>Proceed</b>.</p>" +
    '<p style="margin:0 0 20px">' +
    '<a href="https://mail.google.com/mail/#settings/fwdandpop" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">\uD83D\uDCE7 Open Gmail forwarding settings</a>' +
    "</p>" +
    '<h3 style="margin:28px 0 8px">Step 2 &middot; Verify the forwarding address</h3>' +
    verifyBlock +
    '<h3 style="margin:32px 0 8px">Step 3 &middot; Create the filter</h3>' +
    '<p style="margin:0 0 12px">Click below — Gmail opens with the filter query pre-loaded. From the search dropdown, click <b>Create filter</b>, tick <b>Forward it to</b> &rarr; <code>' +
    bot +
    "</code> &rarr; <b>Create filter</b>.</p>" +
    '<p style="margin:0 0 20px">' +
    '<a href="' +
    prefillUrl +
    '" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">\uD83E\uDE84 Open Gmail with filter pre-filled</a>' +
    "</p>" +
    '<h4 style="margin:28px 0 8px;color:#666;font-size:14px;font-weight:600">Or paste the filter manually</h4>' +
    '<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:13px;user-select:all">' +
    q +
    "</pre>" +
    '<p style="margin:8px 0 0;color:#555;font-size:14px">Then <a href="https://mail.google.com/mail/#settings/filters" target="_blank" rel="noopener" style="color:#1a73e8">open filter settings</a> &rarr; <b>Create a new filter</b> &rarr; paste into <b>Has the words</b> &rarr; <b>Create filter</b> &rarr; tick <b>Forward it to</b> <code>' +
    bot +
    "</code> &rarr; <b>Create filter</b>.</p>" +
    '<p style="margin-top:32px">' +
    '<a href="' +
    demo +
    '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;background:#fff;color:#1a73e8;border:1px solid #1a73e8;text-decoration:none;border-radius:6px;margin-right:8px">Watch 60-sec demo</a>' +
    '<a href="' +
    guide +
    '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;background:#fff;color:#1a73e8;border:1px solid #1a73e8;text-decoration:none;border-radius:6px">Setup guide (with screenshots)</a>' +
    "</p>" +
    "</div>"
  );
}

/**
 * Send the setup email. Throws if MailApp fails. `verifyEmails` are signed
 * into the verify link so the click can scope the inbox scan.
 */
function mailSetupInstructions(chatId, recipients, verifyEmails) {
  var webAppUrl = getWebAppUrl();
  var verifyUrl = webAppUrl ? buildVerifyForwardingUrl(webAppUrl, chatId, null, verifyEmails) : null;
  MailApp.sendEmail({
    to: recipients.join(","),
    subject: "Set up Dus Aane Bot — auto-forward bank alerts",
    htmlBody: buildSetupEmailHtml(buildGmailFilterQuery(), BOT_INBOX_EMAIL, DEMO_VIDEO_URL, SETUP_GUIDE_URL, verifyUrl)
  });
}
