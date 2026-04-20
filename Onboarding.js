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

  var greeting = username ? "👋 Hey " + username + "! " : "";
  var msg =
    greeting +
    "Welcome to Dus Aane Bot — your expenses, under your control.\n\n" +
    "Most finance apps (Cred, etc.) ask for full access to your email, including OTPs, statements, and personal mail. " +
    "This bot flips that: *you* forward only the bank alerts you're comfortable with. Nothing else.\n\n" +
    "*What you get:* instant insights, one message away.\n" +
    "• `/ask how much did I spend on groceries last month?`\n" +
    "• `/stats` — monthly spend, trends, category breakdown\n" +
    "• `/recent` — your latest transactions\n\n" +
    "Open source — audit before you trust: https://github.com/Rrishik/dus-aane-bot\n\n" +
    "*Get started (2 steps):*\n" +
    "1. Forward any bank transaction email to `" +
    BOT_INBOX_EMAIL +
    "`\n" +
    "2. Send `/register your.name@gmail.com`";
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
      "Usage: `/register your.name@gmail.com`\n\nFirst forward a bank email to `" +
        BOT_INBOX_EMAIL +
        "`, then run this command.",
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
    if (owner && String(owner.chat_id) !== String(chatId)) {
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
  if (existingActive && String(existingActive.chat_id) !== String(chatId)) {
    sendTelegramMessage(chatId, "❌ That email is already registered to another account.");
    return;
  }

  // Ownership proof: search bot inbox for a recent forward from this address.
  sendTelegramMessage(chatId, "🔎 Looking for a forward from `" + email + "`...", { parse_mode: "Markdown" });
  var found = findRecentForwardFromEmail(email);
  if (!found) {
    sendTelegramMessage(
      chatId,
      "⚠️ I haven't seen any forward from `" +
        email +
        "` in the last 2 days.\n\n" +
        "From that Gmail account, forward any recent bank transaction email to `" +
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
 * Sends the Gmail filter query + setup steps. Used after activation.
 *
 * Query shape: `from:(<verified senders>) -(subject:OTP OR subject:statement OR ...)`
 * Two layers of protection:
 *   1. Sender allowlist — only verified transaction-alert addresses match.
 *   2. Subject exclusion — extra belt-and-suspenders for anything that ever
 *      shares a sender address (e.g. a bank switching from alerts to newsletters).
 * Uses `-subject:` (not bare `-`) so body mentions of "OTP" in real alerts
 * don't drop the message.
 */
function sendFilterInstructions(chatId) {
  var senders = "from:(" + TRANSACTION_SENDERS.join(" OR ") + ")";
  var excludes = IGNORE_SUBJECTS.map(function (s) {
    return "subject:" + s;
  }).join(" OR ");
  var query = senders + " -(" + excludes + ")";
  var intro =
    "📋 *Automate future forwards (optional)*\n\n" +
    "So you don't forward every email by hand, set up a Gmail filter with the query below. " +
    "It only matches verified bank transaction alerts — no OTPs, statements, or marketing.\n\n" +
    "Gmail → Settings → *Filters and Blocked Addresses* → *Create a new filter* → " +
    "paste the query into *Has the words* → *Forward it to* `" +
    BOT_INBOX_EMAIL +
    "`.";
  sendTelegramMessage(chatId, intro, { parse_mode: "Markdown" });
  sendTelegramMessage(chatId, "```\n" + query + "\n```", { parse_mode: "Markdown" });
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
    lines.push("Sheet: [open](https://docs.google.com/spreadsheets/d/" + tenant.sheet_id + ")");
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
  var sheetUrl = "https://docs.google.com/spreadsheets/d/" + sheetId;
  try {
    sendTelegramMessage(
      pending.chat_id,
      "🎉 *You're all set!*\n\n" +
        "I've created a Google Sheet for you and shared it with `" +
        email +
        "` as editor. *This sheet is yours* — it records every transaction I process, and you can open, edit, export or download it anytime.\n\n" +
        "From now on, every bank email you forward becomes a row here. Tap the button below to open it.",
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "📋 Open your sheet", url: sheetUrl }]] }
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
