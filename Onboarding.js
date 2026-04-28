// Onboarding commands: /start, /register, /myinfo.
// Plus auto-activation: when a pending tenant forwards their first valid bank
// email, we provision their sheet and flip them to active.
//
// Uses Telegram "Markdown" (legacy) parse mode to avoid MarkdownV2 escaping
// pitfalls with `.` and `-` in email addresses.

/**
 * /start — welcome message, differs for new vs onboarded chats.
 */
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
    "*2 steps to activate:*\n" +
    "1. From your Gmail, send a quick `hi` to `" +
    BOT_INBOX_EMAIL +
    "`\n" +
    "2. Back here, send `/register your.name@gmail.com`";
  sendTelegramMessage(chatId, msg, { parse_mode: "Markdown" });
}

/**
 * /register <addr> — claim an email. We search the bot inbox for a recent
 * forward from that address; if found, activate the tenant and send the
 * Gmail filter query to automate future forwards.
 */
function handleRegisterCommand(chatId, username, messageText) {
  var parts = messageText.split(/\s+/);
  if (parts.length < 2) {
    sendTelegramMessage(
      chatId,
      "Usage: `/register your.name@gmail.com`\n\nFirst send a quick `hi` to `" +
        BOT_INBOX_EMAIL +
        "` from that Gmail, then run this command.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  var email = parts[1].trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendTelegramMessage(chatId, "❌ That doesn't look like a valid email. Try: `/register your.name@gmail.com`", {
      parse_mode: "Markdown"
    });
    return;
  }

  // Already active? Just add this email to the list (multi-forwarder case).
  var currentTenant = findTenantByChatId(chatId);
  if (currentTenant && currentTenant.status === TENANT_STATUS.ACTIVE) {
    // Don't let someone add another account's verified email.
    var owner = findTenantByEmail(email);
    if (owner && !sameChatId(owner.chat_id, chatId)) {
      sendTelegramMessage(chatId, "❌ That email is already registered to another account.");
      return;
    }
    upsertPendingTenant(chatId, email, username || currentTenant.name || "");
    // upsertPendingTenant keeps status as-is for existing active rows; re-check.
    var updated = findTenantByChatId(chatId);
    sendTelegramMessage(
      chatId,
      "✅ Added `" +
        email +
        "` to your forwarder list.\n\nRegistered emails:\n" +
        updated.emails.map((e) => "• `" + e + "`").join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Someone else already owns this email — reject.
  var existingActive = findTenantByEmail(email);
  if (existingActive && !sameChatId(existingActive.chat_id, chatId)) {
    sendTelegramMessage(chatId, "❌ That email is already registered to another account.");
    return;
  }

  // Ownership proof: search bot inbox for a recent forward from this address.
  sendTelegramMessage(chatId, "🔎 Looking for a forward from `" + email + "`...", { parse_mode: "Markdown" });
  var found = findRecentForwardFromEmail(email);
  if (!found) {
    sendTelegramMessage(
      chatId,
      "⚠️ I haven't seen any mail from `" +
        email +
        "` in the last 2 days.\n\n" +
        "Send a quick `hi` from that Gmail to `" +
        BOT_INBOX_EMAIL +
        "`, then run `/register " +
        email +
        "` again.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Proof of ownership established. Create pending row, provision sheet, activate.
  upsertPendingTenant(chatId, email, username || "");
  var activated = activatePendingTenantForEmail(email);
  if (!activated) {
    sendTelegramMessage(chatId, "⚠️ Activation failed — please contact the admin.");
    return;
  }
  // The activation helper sends the welcome DM with sheet link. Follow up with
  // the Gmail filter query so they can set up auto-forwarding.
  sendFilterInstructions(chatId);
}

/**
 * Searches the bot inbox for a recent (last 2 days) message where the
 * forwarder was `email` — either via the From: header (manual Gmail forwards
 * rewrite From:) or via the X-Forwarded-For header (Gmail filter auto-forward).
 * Returns true if any match is found.
 */
function findRecentForwardFromEmail(email) {
  var lc = email.toLowerCase();
  try {
    // Manual forward: From: rewritten to user's Gmail.
    var threads = GmailApp.search("in:inbox from:" + lc + " newer_than:2d", 0, 20);
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        var fwd = extractForwarderEmail(msgs[j]);
        if (fwd && fwd.toLowerCase() === lc) return true;
      }
    }
    // Auto-forward: Gmail doesn't expose the X-Forwarded-For header via search
    // operators, so fall back to scanning recent inbox mail by raw headers.
    var recent = GmailApp.search("in:inbox newer_than:2d", 0, 50);
    for (var k = 0; k < recent.length; k++) {
      var msgs2 = recent[k].getMessages();
      for (var m = 0; m < msgs2.length; m++) {
        var f2 = extractForwarderEmail(msgs2[m]);
        if (f2 && f2.toLowerCase() === lc) return true;
      }
    }
  } catch (e) {
    console.error("[findRecentForwardFromEmail] search failed:", e.message);
  }
  return false;
}

/**
 * Build the Gmail filter query that auto-forwards transaction alerts to the
 * bot inbox. Pure function — extracted so it can be reused by the email and
 * the /setup command without re-deriving.
 *
 * Query shape: `from:(<verified senders>) -(subject:OTP OR subject:MPIN OR ...)`
 * The sender allowlist is the primary filter — only verified transaction-alert
 * addresses match. The subject exclusion (FILTER_OTP_SUBJECTS) is narrower than
 * the server-side IGNORE_SUBJECTS: it only blocks OTP / auth-code mail from
 * being auto-forwarded (those must stay in the user's inbox for security).
 * Other non-transaction noise (statements, marketing, login alerts) is dropped
 * server-side after the bot receives the mail — keeping the user-pasted query
 * short and readable.
 */
function buildGmailFilterQuery() {
  var senders = "from:(" + TRANSACTION_SENDERS.join(" OR ") + ")";
  var excludes = FILTER_OTP_SUBJECTS.map(function (s) {
    return "subject:" + s;
  }).join(" OR ");
  return senders + " -(" + excludes + ")";
}

// HTML escape — covers the four characters that matter inside a <pre> block
// or attribute value. Used by buildFilterEmailHtml.
function _escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build a Gmail search URL that pre-loads the filter query. Clicking opens
 * Gmail with the query already typed into the search box; the user then hits
 * the search-dropdown's "Create filter" link and Gmail auto-populates the
 * "Has the words" field — zero copy/paste required.
 *
 * Falls back gracefully: if the URL ends up too long for the browser address
 * bar (~2000 char practical limit), the email still ships the manual paste
 * block as a backup CTA.
 */
function buildGmailFilterPrefillUrl(query) {
  return "https://mail.google.com/mail/#search/" + encodeURIComponent(query);
}

/**
 * Build the HTML body for the filter-setup email. Pure — accepts the query
 * and the bot inbox address, returns a self-contained HTML string. Pulled
 * out for unit-testability (raw HTML string assertions on escaping etc.).
 *
 * UX layout choice: query block comes BEFORE the CTA so the user reads the
 * artifact they need to copy first; the link is the last action in the visual
 * flow. All external links open in a new tab so the email tab survives.
 */
function buildFilterEmailHtml(query, botInboxEmail, demoUrl, guideUrl) {
  var q = _escHtml(query);
  var bot = _escHtml(botInboxEmail);
  var demo = _escHtml(demoUrl);
  var guide = _escHtml(guideUrl);
  var prefillUrl = _escHtml(buildGmailFilterPrefillUrl(query));
  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px">' +
    '<h2 style="margin:0 0 8px">Set up auto-forwarding (~1 min)</h2>' +
    "<p>Skip manual forwarding with one Gmail filter. It only matches verified bank transaction alerts &mdash; no OTPs, statements, or marketing.</p>" +
    '<h3 style="margin:24px 0 8px">Quick path (recommended)</h3>' +
    '<p style="margin:0 0 12px">Click below &mdash; Gmail opens with the query pre-loaded. From the search dropdown, click <b>Create filter</b>, then tick <b>Forward it to</b> &rarr; <code>' +
    bot +
    "</code> &rarr; <b>Create filter</b>. Done.</p>" +
    '<p style="margin:0 0 20px">' +
    '<a href="' +
    prefillUrl +
    '" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">\uD83E\uDE84 Open Gmail with filter pre-filled</a>' +
    "</p>" +
    '<h3 style="margin:28px 0 8px;color:#666;font-size:15px">Or paste manually</h3>' +
    '<p style="margin:0 0 8px;color:#555;font-size:14px">If the button above doesn\'t work, copy this query first:</p>' +
    '<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:13px;user-select:all">' +
    q +
    "</pre>" +
    '<p style="margin:8px 0 0;color:#555;font-size:14px">Then <a href="https://mail.google.com/mail/#settings/filters" target="_blank" rel="noopener" style="color:#1a73e8">open filter settings</a> &rarr; <b>Create a new filter</b> &rarr; paste into <b>Has the words</b> &rarr; <b>Create filter</b> &rarr; tick <b>Forward it to</b> <code>' +
    bot +
    "</code> &rarr; <b>Create filter</b>.</p>" +
    '<p style="margin-top:28px">' +
    '<a href="' +
    demo +
    '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;background:#fff;color:#1a73e8;border:1px solid #1a73e8;text-decoration:none;border-radius:6px;margin-right:8px">Watch 60-sec demo</a>' +
    '<a href="' +
    guide +
    '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;background:#fff;color:#1a73e8;border:1px solid #1a73e8;text-decoration:none;border-radius:6px">Setup guide (with screenshots)</a>' +
    "</p>" +
    '<hr style="margin:28px 0;border:0;border-top:1px solid #eee">' +
    '<p style="font-size:13px;color:#666">If a forwarding-confirmation prompt appears in your inbox afterwards, click the link inside &mdash; Gmail requires this once per destination address.</p>' +
    "</div>"
  );
}

/**
 * Send the filter setup email to one or more tenant email addresses, then
 * send a short Telegram confirmation. Used after activation and from /setup.
 */
function sendFilterInstructions(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (!tenant || tenant.emails.length === 0) {
    sendTelegramMessage(chatId, "⚠️ No registered email yet. Send `/register your.name@gmail.com` first.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var query = buildGmailFilterQuery();
  var html = buildFilterEmailHtml(query, BOT_INBOX_EMAIL, DEMO_VIDEO_URL, SETUP_GUIDE_URL);
  var to = tenant.emails.join(",");
  try {
    MailApp.sendEmail({
      to: to,
      subject: "Set up Dus Aane Bot — auto-forward bank alerts",
      htmlBody: html
    });
  } catch (e) {
    console.error("[sendFilterInstructions] mail send failed:", e.message);
    sendTelegramMessage(chatId, "⚠️ Couldn't email setup instructions right now. Try `/setup` again in a minute.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var emailList = tenant.emails.map((e) => "`" + e + "`").join(", ");
  sendTelegramMessage(
    chatId,
    "📬 Setup instructions emailed to " +
      emailList +
      ".\n\nCheck your inbox (and spam folder, just in case). It includes the Gmail filter query, step-by-step instructions, and a demo video.\n\nResend any time with `/setup`.",
    { parse_mode: "Markdown" }
  );
}

/**
 * /setup — re-send the filter setup email. Useful if the user lost the
 * original or didn't receive it.
 */
function handleSetupCommand(chatId) {
  sendFilterInstructions(chatId);
}

/**
 * /myinfo — show this chat's tenant status.
 */
function handleMyInfoCommand(chatId) {
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
  sendTelegramMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
}

/**
 * Called when extractTransactions sees a forward from an email that matches a
 * pending tenant. Provisions a sheet, activates the tenant, and DMs them a
 * welcome message. Returns the activated tenant or null on failure.
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

  var ok = activateTenant(pending.chat_id, sheetId);
  if (!ok) return null;

  var activated = findTenantByChatId(pending.chat_id);
  var url = sheetUrl(sheetId);
  try {
    sendTelegramMessage(
      pending.chat_id,
      "🎉 *You're all set!*\n\n" +
        "I've created a Google Sheet and shared it with `" +
        email +
        "` as editor. *This sheet is yours* — open, edit or export anytime. It's the *entire* data I use, fully under your control.\n\n" +
        "📬 *Check your Gmail* — Drive has sent an ownership-transfer request. Accept it to fully own the sheet; until then I remain the owner. (I'll stay on as editor afterwards so I can keep adding rows; you can revoke that anytime.)\n\n" +
        "*How it works:* forward any bank transaction email to `" +
        BOT_INBOX_EMAIL +
        "` and it becomes a row here. I'll follow up with a one-time Gmail filter so this happens automatically.",
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

/**
 * Gate non-onboarding commands on an active tenant for this chat.
 * Returns true if the command should be allowed, false if already rejected.
 */
function gateTenantForCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (tenant && tenant.status === TENANT_STATUS.ACTIVE) return true;
  sendTelegramMessage(
    chatId,
    tenant && tenant.status === TENANT_STATUS.PENDING
      ? "⏳ Your setup is still pending. Forward a bank email from your registered address to finish setup."
      : "👋 I don't know this chat yet. Send `/start` to onboard.",
    { parse_mode: "Markdown" }
  );
  return false;
}
