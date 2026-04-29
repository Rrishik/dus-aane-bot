// Onboarding: /start, /register, /account, /ownsheet.
//
// Activation model: /register creates a pending tenant and emails setup
// instructions. The first valid forwarded transaction (manual or filter-
// driven) provisions the sheet via activatePendingTenantForEmail() and flips
// status to active.
//
// Uses Telegram "Markdown" (legacy) parse mode — MarkdownV2 escaping is
// painful with `.` and `-` in email addresses.

function handleStartCommand(chatId, username) {
  var tenant = findTenantByChatId(chatId);
  if (tenant && tenant.status === TENANT_STATUS.ACTIVE) {
    handleHelpCommand(chatId, username);
    return;
  }

  var greeting = username ? "Hey " + username + "! " : "";
  var msg =
    "👋 " +
    greeting +
    "Track your spends by forwarding bank emails — no full-inbox access, no account linking.\n\n" +
    "Worried about apps like Cred reading your OTPs, statements, and personal mail? This [open-source bot](https://github.com/Rrishik/dus-aane-bot) solves that.\n\n" +
    "Send `/register your.email@gmail.com` to begin.";
  sendTelegramMessage(chatId, msg, { parse_mode: "Markdown" });
}

/**
 * /register [<addr>] — claim an email and email auto-forwarding instructions
 * to it. If invoked without an address, stash a pending-input flag so the
 * user's next plain message is treated as the email. No proof-of-ownership
 * step: the email itself is the proof, and activation is gated on the first
 * valid forwarded transaction.
 */
function handleRegisterCommand(chatId, username, messageText) {
  var parts = messageText.split(/\s+/);
  if (parts.length < 2) {
    PropertiesService.getScriptProperties().setProperty("pending_register_" + chatId, "1");
    sendTelegramMessage(
      chatId,
      "📬 What's the Gmail address you'd like to forward bank emails from?\n\n_Reply with just the address, or send_ `/register your.email@gmail.com`.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  registerEmailForChat(chatId, username, parts[1]);
}

/**
 * Consume a plain-text reply when the user is mid-/register flow.
 * Returns true if the message was consumed.
 */
function handleRegisterEmailReply(chatId, username, messageText) {
  var props = PropertiesService.getScriptProperties();
  var key = "pending_register_" + chatId;
  if (!props.getProperty(key)) return false;
  props.deleteProperty(key);
  registerEmailForChat(chatId, username, (messageText || "").trim());
  return true;
}

function registerEmailForChat(chatId, username, rawEmail) {
  var email = (rawEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendTelegramMessage(chatId, "❌ That doesn't look like a valid email. Try: `/register your.email@gmail.com`", {
      parse_mode: "Markdown"
    });
    return;
  }

  // Reject if the address is already attached to a different tenant (active
  // or pending). Same-chat re-registration is a no-op merge.
  var conflict = findTenantByEmail(email) || findPendingTenantByEmail(email);
  if (conflict && !sameChatId(conflict.chat_id, chatId)) {
    sendTelegramMessage(chatId, "❌ That email is already registered to another account.");
    return;
  }

  var currentTenant = findTenantByChatId(chatId);
  upsertPendingTenant(chatId, email, username || (currentTenant && currentTenant.name) || "");

  if (currentTenant && currentTenant.status === TENANT_STATUS.ACTIVE) {
    var updated = findTenantByChatId(chatId);
    sendTelegramMessage(
      chatId,
      "✅ Added `" +
        email +
        "` to your forwarder list.\n\nRegistered emails:\n" +
        updated.emails.map((e) => "• `" + e + "`").join("\n"),
      { parse_mode: "Markdown" }
    );
    sendSetupInstructions(chatId, [email]);
    return;
  }

  sendSetupInstructions(chatId);
}

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

// Source-compat alias for the previous function name.
function buildFilterEmailHtml(query, botInboxEmail, demoUrl, guideUrl, verifyUrl) {
  return buildSetupEmailHtml(query, botInboxEmail, demoUrl, guideUrl, verifyUrl);
}

/**
 * Email setup instructions to the tenant's address(es) and ack on Telegram.
 *
 * @param chatId       Telegram chat id of the requester.
 * @param onlyEmails   Optional subset of emails to send to (e.g. just the
 *                     newly-added forwarder when extending an active tenant).
 */
function sendSetupInstructions(chatId, onlyEmails) {
  var tenant = findTenantByChatId(chatId);
  if (!tenant || tenant.emails.length === 0) {
    sendTelegramMessage(chatId, "⚠️ No registered email yet. Send `/register your.email@gmail.com` first.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var recipients = onlyEmails && onlyEmails.length ? onlyEmails : tenant.emails;
  var query = buildGmailFilterQuery();
  var webAppUrl = getWebAppUrl();
  var verifyUrl = webAppUrl ? buildVerifyForwardingUrl(webAppUrl, chatId) : null;
  var html = buildSetupEmailHtml(query, BOT_INBOX_EMAIL, DEMO_VIDEO_URL, SETUP_GUIDE_URL, verifyUrl);
  try {
    MailApp.sendEmail({
      to: recipients.join(","),
      subject: "Set up Dus Aane Bot — auto-forward bank alerts",
      htmlBody: html
    });
  } catch (e) {
    console.error("[sendSetupInstructions] mail send failed:", e.message);
    sendTelegramMessage(
      chatId,
      "⚠️ Couldn't email setup instructions right now. Try again from `/account` in a minute.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  var emailList = recipients.map((e) => "`" + e + "`").join(", ");
  sendTelegramMessage(
    chatId,
    "📬 Auto-forwarding setup emailed to " +
      emailList +
      ".\n\n" +
      "_You can start right now_ by manually forwarding any bank email to `" +
      BOT_INBOX_EMAIL +
      "`. The email I sent has the steps to skip manual forwarding (~1 min on desktop). Resend any time from `/account`.",
    { parse_mode: "Markdown" }
  );
}

/**
 * /account — show tenant status + a single inline button to resend setup
 * instructions. Replaces the older /myinfo / /setup / /filter trio.
 */
function handleAccountCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (!tenant) {
    sendTelegramMessage(chatId, "No account found for this chat. Use `/start` to onboard.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var lines = [];
  lines.push("*Your account*");
  lines.push("Status: `" + tenant.status + "`");
  if (tenant.name) lines.push("Name: " + tenant.name);
  lines.push("Chat ID: `" + tenant.chat_id + "`");
  lines.push("Emails: " + (tenant.emails.length > 0 ? tenant.emails.map((e) => "`" + e + "`").join(", ") : "_none_"));
  if (tenant.sheet_id) {
    lines.push("Sheet: [open](" + sheetUrl(tenant.sheet_id) + ")");
  } else {
    lines.push("Sheet: _not provisioned yet_");
  }

  var opts = { parse_mode: "Markdown" };
  if (tenant.emails.length > 0) {
    opts.reply_markup = {
      inline_keyboard: [[{ text: "📬 Resend auto-forwarding setup", callback_data: "resend_setup" }]]
    };
  }
  sendTelegramMessage(chatId, lines.join("\n"), opts);
}

/** Callback handler for the "Resend auto-forwarding setup" button on /account. */
function handleResendSetupCallback(chatId, callbackQueryId) {
  try {
    answerCallbackQuery(callbackQueryId, "📬 Sending...", false);
  } catch (_) {}
  sendSetupInstructions(chatId);
}

/**
 * /ownsheet — initiate Drive ownership transfer of the tenant's sheet to
 * their primary registered email. Drive notifies the user; until they
 * accept, admin remains owner (sheet still works because user is editor).
 */
function handleOwnSheetCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (!tenant || tenant.status !== TENANT_STATUS.ACTIVE) {
    sendTelegramMessage(
      chatId,
      "⏳ Your sheet hasn't been provisioned yet. Forward a bank email to finish setup first.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  if (!tenant.sheet_id || tenant.emails.length === 0) {
    sendTelegramMessage(chatId, "⚠️ I don't have a sheet on file for you. Please contact the admin.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var primary = tenant.emails[0];
  var ok = adminTransferSheetOwnership(tenant.sheet_id, primary);
  if (!ok) {
    sendTelegramMessage(
      chatId,
      "⚠️ Drive refused the ownership transfer. Try again in a minute, or contact the admin if it keeps failing.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  sendTelegramMessage(
    chatId,
    "📬 Drive has emailed `" +
      primary +
      "` an ownership-transfer request. Accept it from your inbox to fully own the sheet.\n\n" +
      "_I'll stay on as editor afterwards so I can keep adding rows; you can revoke that anytime from Sheet → Share._",
    { parse_mode: "Markdown" }
  );
}

/**
 * Called when a forward arrives from a pending tenant's email. Provisions
 * the sheet, activates the tenant, and DMs them a welcome message.
 * Returns the activated tenant or null on failure.
 */
function activatePendingTenantForEmail(email) {
  var pending = findPendingTenantByEmail(email);
  if (!pending) return null;

  var sheetId;
  try {
    var label = pending.name || pending.chat_id;
    sheetId = adminProvisionTenantSheet(label, email);
  } catch (e) {
    console.error("[activatePendingTenantForEmail] provision failed:", e.message);
    try {
      sendTelegramMessage(
        pending.chat_id,
        "⚠️ I couldn't create your sheet. Please contact the admin. (" + e.message + ")"
      );
    } catch (_) {}
    return null;
  }

  if (!activateTenant(pending.chat_id, sheetId)) return null;

  var activated = findTenantByChatId(pending.chat_id);
  var url = sheetUrl(sheetId);
  try {
    sendTelegramMessage(
      pending.chat_id,
      "🎉 *Your first transaction is in!*\n\n" +
        "I've created a Google Sheet and shared it with `" +
        email +
        "` as editor. *This sheet is yours* — open, edit or export anytime. It's the entire data I use.\n\n" +
        "_Want to fully own the sheet?_ Run `/ownsheet` and I'll initiate a Drive ownership transfer.",
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "📋 Open your sheet", url: url }]] }
      }
    );
  } catch (e) {
    console.error("[activatePendingTenantForEmail] welcome DM failed:", e.message);
  }
  return activated;
}

function gateTenantForCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (tenant && tenant.status === TENANT_STATUS.ACTIVE) return true;
  sendTelegramMessage(
    chatId,
    tenant && tenant.status === TENANT_STATUS.PENDING
      ? "⏳ Your setup isn't active yet. Forward any bank email to `" +
          BOT_INBOX_EMAIL +
          "` to activate, or run `/account` to resend setup instructions."
      : "👋 I don't know this chat yet. Send `/start` to onboard.",
    { parse_mode: "Markdown" }
  );
  return false;
}
