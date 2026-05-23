// Look up the sheet row for a callback's email message id. If not found, send
// a chat message explaining and return -1 so the caller can early-out. The
// callback ack itself is handled by handleCallbackQuery up-front.
function requireRowForCallback(chatId, emailMessageId) {
  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    sendTelegramMessage(chatId, "❌ *Transaction not found in your sheet.*");
    return -1;
  }
  return rowNumber;
}

// Method to handle messages sent to the Telegram bot.
function handleMessage(update) {
  if (update.message) {
    var chatId = update.message.chat.id;
    var messageText = update.message.text;
    var username = update.message.from.first_name || update.message.from.username;

    if (!messageText) return; // Ignore non-text messages (photos, joins, etc.)

    // Handle commands
    if (messageText.startsWith("/")) {
      var command = messageText.split(" ")[0].split("@")[0].toLowerCase();

      // Group / supergroup chats get their own command set — group-context
      // handlers do member-roster ops, group-sheet reads, and admin checks
      // that the personal handlers don't understand. /register, /ask,
      // /backfill, /recent are personal-only (no analog in groups). Returns
      // here to bypass the personal command switch entirely.
      var chatType = update.message.chat.type;
      if (chatType === "group" || chatType === "supergroup") {
        if (dispatchGroupCommand(command, update)) return;
        // Unknown / unsupported in a group — stay silent to avoid spamming
        // unrelated group chats where someone types /something for a
        // different bot.
        return;
      }

      // Onboarding commands always allowed (they're how tenants are created).
      var ONBOARDING = ["/start", "/register", "/account"];
      if (ONBOARDING.indexOf(command) === -1) {
        if (!gateTenantForCommand(chatId)) return;
      }

      switch (command) {
        case "/start":
          handleStartCommand(chatId, username);
          break;
        case "/register":
          handleRegisterCommand(chatId, username, messageText);
          break;
        case "/account":
          handleAccountCommand(chatId);
          break;
        case "/help":
          handleHelpCommand(chatId, username);
          break;
        case "/recent":
          showRecentTransactions(chatId, messageText);
          break;
        case "/stats":
          handleStatsCommand(chatId);
          break;
        case "/ask":
          handleAskCommand(chatId, messageText);
          break;
        case "/backfill":
          handleBackfillCommand(chatId, messageText);
          break;
        default:
          sendTelegramMessage(chatId, "❌ *Unknown command!*\n\nUse /help to see available commands.");
      }
    }
    // Handle menu button clicks
    else if (messageText === " Recent Transactions") {
      showRecentTransactions(chatId, "/recent");
    } else {
      // Reply-to-bot for /ask follow-up: if this message is replying to a
      // question the bot posted via the ask_user tool, resume that convo
      // directly. Active convos are TTL'd (~10min) and single-use, so a
      // stray reply just falls through harmlessly.
      var replyTo = update.message.reply_to_message;
      if (replyTo && replyTo.message_id && tryResumeAsk(chatId, replyTo.message_id, messageText)) {
        return;
      }

      // Pending-input flows (bare /ask or bare /register stashed a flag and
      // is now waiting for the user's next plain message). Check these first
      // — they're the highest-intent interactions, and merchant edits are
      // keyed by message id so they can't collide.
      if (handleAskQuestionReply(chatId, messageText)) return;
      if (handleRegisterEmailReply(chatId, username, messageText)) return;

      // Pending 🏷 Tag input (user tapped the Tag pill, we stashed
      // <emailMsgId>|<tgMsgId>; now they're typing the brand name).
      var userId = update.message.from.id;
      var props = PropertiesService.getScriptProperties();
      var pendingTagStash = props.getProperty("pending_tag_" + userId);
      if (pendingTagStash) {
        var stashParts = pendingTagStash.split("|");
        var pendingTagMsgId = stashParts[0];
        var pendingTgMsgId = stashParts[1] ? parseInt(stashParts[1], 10) : null;
        if (/^\/cancel\b/i.test(messageText.trim())) {
          props.deleteProperty("pending_tag_" + userId);
          sendTelegramMessage(chatId, "↩️ *Tag unchanged.*", { parse_mode: "Markdown" });
          return;
        }
        var newTag = messageText.trim();
        if (!newTag || newTag.length > TAG_MAX_LEN) {
          // Don't clear pending state — let the user try again without re-tapping.
          sendTelegramMessage(
            chatId,
            "❌ *Tag must be 1–" +
              TAG_MAX_LEN +
              " characters.* Try a shorter name, or /cancel to keep the current tag.",
            { parse_mode: "Markdown" }
          );
          return;
        }
        props.deleteProperty("pending_tag_" + userId);
        applyMerchantTag(chatId, pendingTagMsgId, newTag, pendingTgMsgId);
        return;
      }
    }
  }
}

// Route a slash command coming from a group/supergroup chat to the group-
// context handler. Returns true if handled (including when the handler
// itself emitted a "group not set up" reply), false if the command isn't
// supported in groups (caller decides whether to ignore or warn).
//
// /start is the provisioning command and intentionally bypasses
// gateTenantForCommand — the whole point is that the tenant doesn't exist
// yet. Every other group command gates first so the same "send /start"
// guidance comes out of handleGroup*Command's own status check.
function dispatchGroupCommand(command, update) {
  switch (command) {
    case "/start":
      handleGroupStartCommand(update);
      return true;
    case "/help":
      handleGroupHelpCommand(update);
      return true;
    case "/account":
      handleGroupAccountCommand(update);
      return true;
    case "/stats":
      handleGroupStatsCommand(update);
      return true;
    case "/settle":
      handleGroupSettleCommand(update);
      return true;
    default:
      return false;
  }
}

// Shared input cap for tag values. Mirrors TelegramUtils.TAG_MAX_LEN so a typed
// tag never overflows the button pill (both pieces are deliberately kept the
// same constant value; duplicated to keep the two files independent).
var TAG_MAX_LEN = 18;

// Write a user-supplied tag for the merchant on this transaction row.
//   1. Update the row's MERCHANT column so this card now reads as the tag.
//   2. Update the MerchantResolution row whose pattern equals the row's
//      pre-update merchant — so future emails with the same raw payee
//      string auto-resolve to this tag. If no such row exists (rare —
//      addNewMerchantIfNeeded runs at save time), append one.
//   3. Refresh the original card's keyboard so the 🏷 pill shows the new
//      tag in-place (no extra confirmation message).
function applyMerchantTag(chatId, emailMessageId, newTag, telegramMessageId) {
  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    sendTelegramMessage(chatId, "❌ *Transaction not found.*", { parse_mode: "Markdown" });
    return;
  }
  var sheet = getSpreadsheet().getSheets()[0];
  var currentMerchant = (sheet.getRange(rowNumber, MERCHANT_COLUMN).getValue() || "").toString().trim();

  // Make sure a MerchantResolution row exists for the current merchant,
  // then point its Resolved column at the new tag. Also generalize the
  // pattern — strip trailing transaction-id digits so future numbered
  // variants ("bundl tech 99999") auto-resolve to the same tag too.
  // addNewMerchantIfNeeded is a no-op if the row already exists;
  // setMerchantResolution succeeds either way.
  if (currentMerchant) {
    var pattern = shortenMerchantPattern(currentMerchant);
    if (pattern && pattern !== currentMerchant) {
      addNewMerchantIfNeeded(pattern);
      setMerchantResolution(pattern, newTag);
    }
    addNewMerchantIfNeeded(currentMerchant);
    setMerchantResolution(currentMerchant, newTag);
  }

  // Reflect the tag on this row immediately so /recent and /ask see it.
  updateGoogleSheetCellWithFeedback(rowNumber, MERCHANT_COLUMN, newTag, currentMerchant);

  // Refresh the original card's keyboard so the 🏷 pill now reads as the
  // new tag. No new confirmation message — the in-place change is the ack.
  // We can't editMessageText without the card body, and we don't have it
  // here, so use editMessageReplyMarkup instead (keyboard-only edit).
  if (telegramMessageId) {
    var rowData = sheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
    var newKb = buildKeyboardForRow(
      chatId,
      emailMessageId,
      newTag,
      rowData[CATEGORY_COLUMN - 1],
      rowData[GROUP_REF_COLUMN - 1]
    );
    editTelegramReplyMarkup(chatId, telegramMessageId, newKb);
    return;
  }

  // Fallback (no telegramMessageId stashed): keep the old behavior of
  // sending a confirmation message. Shouldn't fire in practice.
  sendTelegramMessage(chatId, "✅ *Tagged as " + escapeMarkdown(newTag) + ".* Future transactions will auto-tag.", {
    parse_mode: "Markdown"
  });
}

// Pick the correct default keyboard for a txn row. Post-split rows (those
// with a GROUP_REF) get the "↩️ Make personal again" undo keyboard;
// regular personal rows get the Level 0 keyboard with the group-split
// parent buttons.
function buildKeyboardForRow(chatId, emailMessageId, merchant, category, groupRef) {
  if (groupRef) {
    return buildPostSplitDMKeyboard(emailMessageId, merchant, category);
  }
  return buildTransactionLevel0Keyboard(chatId, emailMessageId, merchant, category);
}

// Method to handle the /help command (also handles /start)
function handleHelpCommand(chatId, username) {
  var message =
    `*Commands*\n` +
    `• /ask — ask anything about your spending\n` +
    `   _e.g. /ask how much on food last month?_\n` +
    `• /stats — dashboard: recent, trends, who owes\n` +
    `• /register — add another Gmail to forward from\n` +
    `• /account — status, sheet link, resend setup\n` +
    `• /help — this message`;

  var url = sheetUrl(getTenantSheetId());
  sendTelegramMessage(chatId, message, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📋 Open Sheet", url: url },
          { text: "📖 README", url: "https://github.com/Rrishik/dus-aane-bot#readme" }
        ]
      ]
    }
  });
}

// Method to handle the callback queries sent from the Telegram message reply buttons.
function handleCallbackQuery(update) {
  try {
    if (!update.callback_query) {
      return;
    }

    var callbackQueryId = update.callback_query.id;
    var chatId = update.callback_query.message.chat.id;
    var telegramMessageId = update.callback_query.message.message_id;
    var messageText = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "split_abc123", "partner_abc123", "personal_abc123"

    if (!data) {
      sendTelegramMessage(chatId, "❌ *Error: No data received*");
      return;
    }

    // Group-split UI callbacks use ":" as separator (gnav, gsp, gset, gst,
    // gbk, gun, gstats). Dispatch before the legacy "_" parser. handleGroupCallback
    // owns the ack, so we must not pre-ack here (Telegram 400s on dupes).
    if (isGroupCallback(data)) {
      handleGroupCallback(update);
      return;
    }

    // Parse action and message ID from callback data
    var separatorIndex = data.indexOf("_");
    if (separatorIndex < 0) {
      sendTelegramMessage(chatId, "❌ *Error: Invalid request*");
      return;
    }

    var action = data.substring(0, separatorIndex); // "personal", "split", "partner", "editcat", "cat", "del", "setmerch", "stats", etc.
    var callbackPayload = data.substring(separatorIndex + 1);

    // Ack the callback up front so Telegram clears the button spinner
    // immediately (~150-300ms) instead of waiting on sheet I/O. All later
    // per-branch toasts/errors must go through sendTelegramMessage —
    // Telegram only honors one answerCallbackQuery per callback_query_id.
    answerCallbackQuery(callbackQueryId, "");

    // "Upgrade to Premium" upsell — shown after a user hits the /ask cap.
    // Premium isn't built yet; we just acknowledge intent and measure who
    // taps it (via Telegram update logs). The 5/day cap is the same for
    // everyone for now; this branch will graduate into a real upgrade flow
    // once we set pricing.
    if (data === "premium_info") {
      sendTelegramMessage(chatId, "\u{1F48E} *Premium coming soon* \u2014 we'll let you know when it's ready.");
      return;
    }

    // Handle stats callbacks: stats_recent, stats_trends
    if (action === "stats") {
      return handleStatsCallback(chatId, telegramMessageId, callbackQueryId, callbackPayload);
    }

    // Handle "📂 Category" pill — swap the card's keyboard to the category
    // picker in place (no new message). The picker has a back row so the
    // user can bail without picking.
    if (action === "editcat") {
      var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, callbackPayload);
      var catList = CATEGORIES;
      if (rowNumber > 0) {
        var sheet = getSpreadsheet().getSheets()[0];
        catList = getCategoryListForType(sheet.getRange(rowNumber, TRANSACTION_TYPE_COLUMN).getValue());
      }
      editTelegramReplyMarkup(chatId, telegramMessageId, buildCategoryKeyboard(callbackPayload, catList));
      return;
    }

    // Handle category selection: cat_{messageId}_{index}. Writes the new
    // category + override, then restores the default keyboard on the same
    // card (pills row reflects the new category).
    if (action === "cat") {
      var lastUnderscore = callbackPayload.lastIndexOf("_");
      if (lastUnderscore < 0) {
        sendTelegramMessage(chatId, "❌ *Invalid category data*");
        return;
      }
      var emailMessageId = callbackPayload.substring(0, lastUnderscore);
      var categoryIndex = parseInt(callbackPayload.substring(lastUnderscore + 1), 10);

      // Look up transaction type to determine which category list to use
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;

      var sheet = getSpreadsheet().getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
      var catList = getCategoryListForType(rowData[TRANSACTION_TYPE_COLUMN - 1]);

      if (isNaN(categoryIndex) || categoryIndex < 0 || categoryIndex >= catList.length) {
        sendTelegramMessage(chatId, "❌ *Invalid category*");
        return;
      }

      var newCategory = catList[categoryIndex];
      var currentMerchant = (rowData[MERCHANT_COLUMN - 1] || "").toString().trim();
      var currentCategory = rowData[CATEGORY_COLUMN - 1];
      var updateResult = updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, newCategory, currentCategory);

      if (!updateResult.success) {
        sendTelegramMessage(chatId, "❌ " + updateResult.message);
        return;
      }

      // Silently teach the bot: next time this merchant shows up, default to
      // the same category. No extra prompt — the explicit per-row tap is also
      // the implicit "this is what I mean for this merchant" signal.
      if (currentMerchant) setCategoryOverride(currentMerchant, newCategory);

      // Swap back to the default keyboard so the 📂 pill now reads the new
      // category. No "✅ Updated" message — the in-place pill update is the
      // ack.
      var newKb = buildKeyboardForRow(
        chatId,
        emailMessageId,
        currentMerchant,
        newCategory,
        rowData[GROUP_REF_COLUMN - 1]
      );
      editTelegramReplyMarkup(chatId, telegramMessageId, newKb);
      return;
    }

    // Handle "🏷 Tag" — prompt for a short brand name; stored against the row's
    // current merchant in MerchantResolution so future emails auto-tag.
    // We also stash the txn card's telegram message id so the post-reply
    // handler can refresh the 🏷 pill on the original card in place.
    if (action === "tag") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      var sheet = getSpreadsheet().getSheets()[0];
      var currentTag = (sheet.getRange(rowNumber, MERCHANT_COLUMN).getValue() || "").toString().trim();
      var userIdTag = update.callback_query.from.id;
      var propsTag = PropertiesService.getScriptProperties();
      propsTag.setProperty("pending_tag_" + userIdTag, emailMessageId + "|" + telegramMessageId);
      var prompt = currentTag
        ? "🏷 *Tag merchant*\nCurrently tagged as *" +
          escapeMarkdown(currentTag) +
          "*.\n\nReply with a new brand name (up to " +
          TAG_MAX_LEN +
          " chars), or /cancel to keep " +
          escapeMarkdown(currentTag) +
          "."
        : "🏷 *Tag merchant*\nReply with the brand name (up to " + TAG_MAX_LEN + " chars), or /cancel.";
      sendTelegramMessage(chatId, prompt, {
        parse_mode: "Markdown",
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: "e.g. Swiggy" }
      });
      return;
    }

    // Handle "❓" help-menu open. Swaps the action row to the help menu
    // (Report + Delete, with a Back).
    if (action === "help") {
      editTelegramReplyMarkup(chatId, telegramMessageId, buildHelpMenuKeyboard(callbackPayload));
      return;
    }

    // Handle "← Back" / "← Cancel" from the picker / help / confirm menus.
    // Re-derives the default keyboard from the row (so any pill changes the
    // user made via the picker are reflected).
    if (action === "back") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      var sheet = getSpreadsheet().getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
      var newKb = buildKeyboardForRow(
        chatId,
        emailMessageId,
        rowData[MERCHANT_COLUMN - 1],
        rowData[CATEGORY_COLUMN - 1],
        rowData[GROUP_REF_COLUMN - 1]
      );
      editTelegramReplyMarkup(chatId, telegramMessageId, newKb);
      return;
    }

    // Handle delete request: swap to a two-step confirm. The actual delete
    // happens on `delyes` so an accidental tap from the help menu is
    // recoverable.
    if (action === "del") {
      editTelegramReplyMarkup(chatId, telegramMessageId, buildDeleteConfirmKeyboard(callbackPayload));
      return;
    }

    // Handle delete confirm: delyes_{messageId}. Executes the deletion,
    // tombstones the card body, drops the keyboard.
    if (action === "delyes") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;

      deleteSheetRow(rowNumber);

      sendTelegramMessage(chatId, "🗑️ *Transaction deleted*", {
        parse_mode: "Markdown",
        message_id: telegramMessageId
      });
      return;
    }

    // Handle "⚠ Report error" — DM the admin with row context so we can
    // investigate the parser miss, then swap the keyboard to a "reported"
    // acknowledgement with a Back so the user isn't stuck.
    if (action === "report") {
      var emailMessageId = callbackPayload;
      var rowNumber = requireRowForCallback(chatId, emailMessageId);
      if (rowNumber < 0) return;
      var sheet = getSpreadsheet().getSheets()[0];
      var rowData = sheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
      var reportMerchant = rowData[MERCHANT_COLUMN - 1] || "(unknown)";
      var reportAmount = rowData[AMOUNT_COLUMN - 1];
      var reportCurrency = "INR"; // personal sheet has no currency column today
      var reportEmailLink = rowData[EMAIL_LINK_COLUMN - 1] || "";
      var reportFrom = update.callback_query.from || {};
      var reportName = reportFrom.first_name || reportFrom.username || String(chatId);
      var adminBody =
        "⚠️ *Reported txn*\n" +
        "from: " +
        escapeMarkdown(reportName) +
        " (chat " +
        chatId +
        ")\n" +
        "merchant: " +
        escapeMarkdown(String(reportMerchant)) +
        "\n" +
        "amount: " +
        reportCurrency +
        " " +
        reportAmount +
        "\n" +
        "msg id: " +
        emailMessageId +
        (reportEmailLink ? "\n" + reportEmailLink : "");
      try {
        sendTelegramMessage(ADMIN_CHAT_ID, adminBody, { parse_mode: "Markdown", disable_web_page_preview: true });
      } catch (e) {
        console.error("[report] admin DM failed:", e && e.message);
      }
      // Show ack in the help-menu shape (Back returns to default).
      editTelegramReplyMarkup(chatId, telegramMessageId, {
        inline_keyboard: [[{ text: "📩 Reported — thanks!", callback_data: "back_" + emailMessageId }]]
      });
      return;
    }

    // Handle "💬 Follow up" — user wants to continue the /ask conversation
    // attached to this message. We swap the original message's keyboard
    // off (single-use) and send a fresh force_reply prompt; the convo is
    // re-stashed against the prompt's message id so the user's reply
    // resumes the loop via tryResumeAsk.
    if (action === "askfu") {
      var convo = null;
      try {
        convo = loadAskConvo(chatId, telegramMessageId);
      } catch (_) {}
      // Always clear the button so a stale tap can't loop us. If the stash
      // already expired/cleared, we tell the user and bail.
      editTelegramReplyMarkup(chatId, telegramMessageId, { inline_keyboard: [] });
      if (!convo) {
        sendTelegramMessage(chatId, "_That follow-up window has expired. Start a fresh /ask whenever you're ready._");
        return;
      }
      try {
        clearAskConvo(chatId, telegramMessageId);
      } catch (_) {}
      var promptRaw = sendTelegramMessage(chatId, "_What's your follow-up?_", {
        reply_markup: { force_reply: true, selective: true }
      });
      var promptMsgId = _parseSentMessageId(promptRaw);
      if (promptMsgId) {
        saveAskConvo(chatId, promptMsgId, convo.messages, convo.askCallId || null, convo.turn || 1);
      }
      return;
    }

    // Anything that reaches here is unhandled. All split actions are
    // dispatched through the group-callback path (gnav/gsp/gset/gst/...)
    // earlier in this function; the legacy personal/split/partner toggle
    // was removed once the group-split flow took over.
    sendTelegramMessage(chatId, "❌ *Unknown action*");
  } catch (error) {
    console.error("[handleCallbackQuery] Error:", error.message, error.stack);
    if (update.callback_query && update.callback_query.message && update.callback_query.message.chat) {
      sendTelegramMessage(update.callback_query.message.chat.id, "❌ *Error:* " + escapeMarkdown(error.message));
    }
  }
}

// Function to show transaction summary. Optional limit param: /summary 10
// Function to show recent transactions
// Supports: /recent, /recent 10, /recent rishik, /recent 10 rishik
function showRecentTransactions(chatId, messageText) {
  try {
    var parts = messageText.trim().split(/\s+/);
    parts.shift(); // remove "/recent"

    var limit = 5;
    var userFilter = null;

    // Parse params: number = limit, string = user filter
    parts.forEach(function (part) {
      if (/^\d+$/.test(part)) {
        limit = parseInt(part, 10);
      } else {
        userFilter = part.toLowerCase();
      }
    });

    var result = buildRecentTransactionsMessage(limit, userFilter);
    sendTelegramMessage(chatId, result.text);
  } catch (error) {
    console.error("Error in showRecentTransactions:", error);
    sendTelegramMessage(chatId, "❌ *Error fetching recent transactions*\n\nPlease try again later.");
  }
}

// Build the markdown body for a "recent N transactions" view. Pure-ish — reads
// the tenant sheet but returns text only, no Telegram I/O. Used both by the
// typed `/recent` command (above) and the 🕒 Recent button in /stats.
//
// Two schemas to read. Personal and group tenants store transactions on
// completely different sheet layouts (see G_*_COLUMN in Constants.js):
//   - Personal: 1 row per transaction. Type at col 6, currency col 10,
//     category col 5, payer (gmail local-part) col 7.
//   - Group: N rows per transaction (one per share-holder). Type at col 11,
//     currency col 5, category col 10, payer (chat_id) col 6, share-holder
//     (chat_id) col 7, Tx ID col 9.
// Pre-fix /recent was reading the personal columns against a group sheet,
// which meant type (col 6) was actually a chat_id ("3893…"), so isDebit()
// was always false and every row rendered with the credit emoji and showed
// the chat_id verbatim instead of a username. Now we branch on chat_type
// and dedupe by Tx ID so the user sees N transactions, not N×members rows.
function buildRecentTransactionsMessage(limit, userFilter) {
  // Cap limit to keep the webhook response snappy.
  if (limit > 50) limit = 50;
  if (limit < 1) limit = 1;

  var tenant = getCurrentTenant();
  var isGroup = tenant && tenant.chat_type === TENANT_CHAT_TYPE.GROUP;

  var sheet = getSpreadsheet().getSheets()[0];
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { text: "📅 *No transactions found yet!*" };
  }

  // Skip header row
  data.shift();

  // Group sheet stores one row per share-holder. Keep only the first row
  // per Tx ID so /recent lists distinct transactions, not the share ledger.
  // Iterate from the bottom so the kept row is the most-recent appearance
  // (defensive against any future row-rewrite logic).
  if (isGroup) {
    var seen = {};
    var deduped = [];
    for (var di = data.length - 1; di >= 0; di--) {
      var txId = (data[di][G_TX_ID_COLUMN - 1] || "").toString();
      if (txId && seen[txId]) continue;
      if (txId) seen[txId] = true;
      deduped.unshift(data[di]);
    }
    data = deduped;
  }

  // Per-schema row reader. Group payer is a Telegram chat_id; resolve to
  // the personal tenant's `name` so the display matches /stats member labels
  // and settlement buttons. Falls back to the raw chat_id only when the
  // member's tenant row is missing or unnamed (rare mid-onboarding case).
  var pickRow;
  if (isGroup) {
    pickRow = function (row) {
      var payerId = (row[G_PAID_BY_COLUMN - 1] || "").toString();
      var payerLabel = payerId;
      if (payerId) {
        var t = findTenantByChatId(payerId);
        if (t && t.name) payerLabel = t.name;
      }
      return {
        rawDate: row[G_EMAIL_DATE_COLUMN - 1] || row[G_TRANSACTION_DATE_COLUMN - 1],
        merchant: row[G_MERCHANT_COLUMN - 1] || "Unknown",
        amount: parseFloat(row[G_AMOUNT_COLUMN - 1]) || 0,
        type: row[G_TRANSACTION_TYPE_COLUMN - 1] || "Unknown",
        category: row[G_CATEGORY_COLUMN - 1] || "",
        currency: row[G_CURRENCY_COLUMN - 1] || "INR",
        userLabel: payerLabel
      };
    };
  } else {
    pickRow = function (row) {
      return {
        rawDate: row[EMAIL_DATE_COLUMN - 1] || row[TRANSACTION_DATE_COLUMN - 1],
        merchant: row[MERCHANT_COLUMN - 1] || "Unknown",
        amount: parseFloat(row[AMOUNT_COLUMN - 1]) || 0,
        type: row[TRANSACTION_TYPE_COLUMN - 1] || "Unknown",
        category: row[CATEGORY_COLUMN - 1] || "",
        currency: row[CURRENCY_COLUMN - 1] || "INR",
        userLabel: (row[USER_COLUMN - 1] || "").toString()
      };
    };
  }

  var picked = data.map(pickRow);

  if (userFilter) {
    var needle = userFilter.toLowerCase();
    picked = picked.filter(function (p) {
      return p.userLabel.toLowerCase().indexOf(needle) !== -1;
    });
  }

  if (picked.length === 0) {
    return userFilter
      ? { text: "📅 *No transactions found* for user: " + userFilter }
      : { text: "📅 *No transactions found yet!*" };
  }

  var recentTransactions = picked.slice(-limit).reverse();

  var header = "📅 *Recent Transactions*";
  if (userFilter) header += " (user: " + userFilter + ")";
  var message = header + "\n";

  // Show the payer username inline on the date row in group chats — same
  // chat_type gate as the Who Owes button in /stats and the 👤 line in
  // transaction notifications. In a multi-person group "Swiggy ₹450" alone
  // doesn't tell you who paid. In personal chats the same name on every
  // row would just clutter the card.
  var showUser = isGroup;

  recentTransactions.forEach(function (p) {
    var date =
      p.rawDate instanceof Date
        ? Utilities.formatDate(p.rawDate, Session.getScriptTimeZone(), "dd MMM yyyy, HH:mm")
        : p.rawDate || "Unknown Date";

    var emoji = isDebit(p.type) ? "🔴" : "🟢";
    var money = currencySymbol(p.currency) + formatAmount(p.amount);
    var catLabel = p.category ? " · " + shortCategoryName(p.category) : "";
    var userTag = showUser && p.userLabel ? " · 👤 " + escapeMarkdown(p.userLabel) : "";

    // Two lines per entry, blank line between. No ─── dividers — line
    // spacing alone is enough separation, and dividers were dominating the
    // visual weight of every row. In groups, the user tag rides on the
    // second line next to the date so the headline stays the most-scanned
    // facts (merchant + amount).
    message += "\n" + emoji + " *" + escapeMarkdown(p.merchant) + "* " + money + catLabel + "\n";
    message += "   _" + escapeMarkdown(date) + "_" + userTag + "\n";
  });

  return { text: message };
}

// ─── Stats Command ───────────────────────────────────────────────────

function handleStatsCommand(chatId) {
  sendTelegramMessage(chatId, "📊 *Stats* — pick a view:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buildStatsMenuKeyboard(getCurrentTenant()) }
  });
}

// Pure-data builder — used both by /stats entry and the back button.
// One row keeps each button label readable on narrow phone screens.
//
// Monthly was dropped: Trends already shows each month's INR debit total as
// a bar chart and gives MoM deltas + biggest category movers, which covered
// the same intent more compactly. Top-5-txns-by-amount and per-user breakdown
// (Monthly's other features) are recoverable via /ask.
function buildStatsMenuKeyboard(tenant) {
  return [
    [
      { text: "🕒 Recent", callback_data: "stats_recent" },
      { text: "📉 Trends", callback_data: "stats_trends" }
    ]
  ];
}

// ─── Ask Command (AI tool-calling) ───────────────────────────────────

function handleAskCommand(chatId, messageText) {
  try {
    var question = messageText.replace(/^\/ask(@\w+)?\s*/i, "").trim();

    // Tapped /ask from the slash menu (or sent /ask with no question): stash
    // a pending flag and prompt for the question. The next plain-text message
    // from this chat is consumed by handleAskQuestionReply. Mirrors the
    // /register-without-address flow. Plain text (no parse_mode) — keeps the
    // prompt bullet-proof against future markdown-special chars in the copy.
    if (!question) {
      PropertiesService.getScriptProperties().setProperty("pending_ask_" + chatId, "1");
      sendTelegramMessage(
        chatId,
        "❓ What would you like to know about your spending?\n\n" +
          "Examples:\n" +
          "• How much did we spend on food?\n" +
          "• Top merchants this month\n" +
          "• Who owes whom in March?\n" +
          "• Compare grocery spending Feb vs Mar\n\n" +
          "Reply with your question, or send /ask <question> directly.",
        {
          reply_markup: { force_reply: true, input_field_placeholder: "Ask about your spending…" }
        }
      );
      return;
    }

    // Direct /ask <question>: clear any stale pending-ask flag so a follow-up
    // plain message isn't accidentally consumed as another question.
    PropertiesService.getScriptProperties().deleteProperty("pending_ask_" + chatId);
    runAskFlow(chatId, question);
  } catch (e) {
    console.error("handleAskCommand failed:", e && e.message, e && e.stack);
    try {
      sendTelegramMessage(chatId, "❌ Something went wrong handling /ask. Please try again.");
    } catch (_) {}
  }
}

// Consume a plain-text reply when the user is mid-/ask flow. Returns true
// if the message was consumed (and therefore handleMessage should stop).
function handleAskQuestionReply(chatId, messageText) {
  var props = PropertiesService.getScriptProperties();
  var key = "pending_ask_" + chatId;
  if (!props.getProperty(key)) return false;
  props.deleteProperty(key);
  var question = (messageText || "").trim();
  if (!question) {
    sendTelegramMessage(chatId, "❌ Empty question, /ask cancelled.");
    return true;
  }
  runAskFlow(chatId, question);
  return true;
}

// Shared core: quota → typing indicator → LLM loop → send answer. Used by
// both the direct /ask <question> path and the pending-input reply path.
// Any uncaught throw inside the LLM loop, sheet read, or quota update is
// surfaced to the user as a chat message — silent failure here means the
// user sees nothing and assumes /ask is broken.
function runAskFlow(chatId, question) {
  _runAskInternal(chatId, function () {
    return runAskLoop(
      question,
      function () {
        sendChatAction(chatId, "typing");
      },
      { chatId: chatId }
    );
  });
}

// Resume a /ask conversation that was suspended by an ask_user tool call,
// by the question-detection safety net, or by a "Follow up" button tap.
// `convo` is the cache entry loaded by tryResumeAsk; `userText` is the
// user's free-text reply.
//
// When `convo.askCallId` is set the suspension came from a real `ask_user`
// tool_call and the reply must satisfy that pending tool_call as a `tool`
// message. When it's null the suspension was synthetic (question-detection
// or follow-up button) and the reply is just the next user turn.
function resumeAsk(chatId, convo, userText) {
  var nextTurn = (convo.turn || 1) + 1;
  var replyMessage = convo.askCallId
    ? { role: "tool", tool_call_id: convo.askCallId, content: String(userText == null ? "" : userText) }
    : { role: "user", content: String(userText == null ? "" : userText) };
  var resumedMessages = (convo.messages || []).concat([replyMessage]);
  _runAskInternal(chatId, function () {
    return runAskLoop(
      null,
      function () {
        sendChatAction(chatId, "typing");
      },
      { messages: resumedMessages, turn: nextTurn, chatId: chatId }
    );
  });
}

// Look up an active suspended /ask convo for the message the user replied
// to and continue it. Returns true if the reply was consumed (caller should
// stop dispatch). Single-use semantics — the cache entry is cleared up-front
// so a double-reply can't double-charge quota.
function tryResumeAsk(chatId, replyToMessageId, userText) {
  if (!replyToMessageId) return false;
  var convo = null;
  try {
    convo = loadAskConvo(chatId, replyToMessageId);
  } catch (_) {
    return false;
  }
  if (!convo) return false;
  try {
    clearAskConvo(chatId, replyToMessageId);
  } catch (_) {}
  resumeAsk(chatId, convo, userText);
  return true;
}

// Common quota + typing + dispatch wrapper shared by /ask and resume paths.
// `runLoop` is a thunk returning the runAskLoop result, so the caller can
// build messages either fresh-from-question or resumed-from-cache without
// duplicating quota / typing / send / refund logic.
function _runAskInternal(chatId, runLoop) {
  var quotaConsumed = false;
  try {
    // Daily /ask cap. consumeAskQuota is atomic (LockService) and tracks both
    // the daily counter and lifetime/cap-hit metrics on the Tenants row. We
    // consume *before* spending Azure tokens; if runAskLoop later throws we
    // refund so a failed call doesn't burn a slot.
    var quota = consumeAskQuota(chatId);
    if (!quota.allowed) {
      sendTelegramMessage(chatId, formatAskCapHitMessage(new Date()), {
        reply_markup: buildAskCapHitKeyboard()
      });
      return;
    }
    quotaConsumed = true;

    // Show "typing..." in the chat header instead of a "🤔 Thinking..." message.
    // Telegram clears the indicator automatically when the bot's next message
    // arrives, so there's nothing to delete or edit on success. The indicator
    // expires after ~5s, so runAskLoop re-emits it before each LLM iteration
    // via the onProgress callback (most /ask runs take 5-15s).
    sendChatAction(chatId, "typing");

    var result = runLoop();

    // Defensive: older callers/stubs may still return a bare string. Treat
    // those as a final answer.
    if (typeof result === "string" || result == null) {
      sendTelegramMessage(chatId, escapeMarkdown(String(result == null ? "" : result)));
      return;
    }

    if (result.kind === "suspend") {
      // Force-reply prompt so Telegram pre-fills the reply UI. We need the
      // returned message_id to key the cached convo, so parse the raw API
      // response.
      var raw = sendTelegramMessage(chatId, escapeMarkdown(result.text), {
        reply_markup: { force_reply: true, selective: true }
      });
      var botMsgId = _parseSentMessageId(raw);
      if (botMsgId) {
        saveAskConvo(chatId, botMsgId, result.messages, result.askCallId, result.turn || 1);
      }
      return;
    }

    // final — attach a "Follow up" button so the user has an explicit way
    // to continue the conversation without remembering to retype /ask. We
    // skip the button (and the convo stash) once the turn count would
    // overflow ASK_MAX_TURNS on the next resume, since the loop would
    // refuse anyway.
    if (result.kind === "final") {
      var currentTurn = result.turn || 1;
      var hasFollowupSlot = result.messages && currentTurn < ASK_MAX_TURNS;
      var opts = hasFollowupSlot
        ? { reply_markup: { inline_keyboard: [[{ text: "💬 Follow up", callback_data: "askfu_" + currentTurn }]] } }
        : {};
      var finalRaw = sendTelegramMessage(chatId, escapeMarkdown(result.text), opts);
      if (hasFollowupSlot) {
        var finalMsgId = _parseSentMessageId(finalRaw);
        if (finalMsgId) {
          saveAskConvo(chatId, finalMsgId, result.messages, null, currentTurn);
        }
      }
      return;
    }

    // error — plain markdown-escaped text, no follow-up affordance
    sendTelegramMessage(chatId, escapeMarkdown(result.text));
  } catch (error) {
    if (quotaConsumed) {
      try {
        refundAskQuota(chatId);
      } catch (_) {}
    }
    console.error("runAskFlow failed:", error && error.message, error && error.stack);
    try {
      sendTelegramMessage(chatId, "❌ Something went wrong. Try /stats for preset analytics.");
    } catch (_) {}
  }
}

// Parse the message_id out of a Telegram sendMessage response. The raw
// string is what sendTelegramMessage returns from response.getContentText().
// Tolerates already-parsed objects (some tests stub it that way) and any
// malformed payload — returns null on miss.
function _parseSentMessageId(raw) {
  if (!raw) return null;
  try {
    var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && parsed.ok && parsed.result ? parsed.result.message_id : null;
  } catch (_) {
    return null;
  }
}

function handleStatsCallback(chatId, telegramMessageId, callbackQueryId, subAction) {
  try {
    // Back button — restore the dashboard menu in place.
    if (subAction === "back") {
      sendTelegramMessage(chatId, "📊 *Stats* — pick a view:", {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: buildStatsMenuKeyboard(getCurrentTenant()) }
      });
      return;
    }

    if (subAction === "recent") {
      // 🕒 Recent inside /stats — same content as the typed /recent command,
      // rendered in place with a Back button. The typed-command path is
      // unchanged for power users who want filters (e.g. /recent 10 rishik).
      var recent = buildRecentTransactionsMessage(5, null);
      sendTelegramMessage(chatId, recent.text, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: [buildStatsBackRow()] }
      });
      return;
    }

    if (subAction === "trends" || subAction === "trendsweekly" || subAction === "trendsmonthly") {
      // Default Trends view is weekly — finer-grained signal than the monthly
      // bars, more useful day-to-day, and lines up with the Friday cron's
      // weekly digest. Tap the toggle row to switch granularity. The whole
      // thing is one editMessageText per tap so the message body stays in
      // place; only the body + toggle button label change.
      var mode = subAction === "trendsmonthly" ? "monthly" : "weekly";
      var msg;
      if (mode === "monthly") {
        var months = getTrendsAnalytics(6);
        msg = formatTrendsMessage(months, {
          title: "📉 *Spending Trends* — Monthly",
          comparisonLabel: "vs Last Month"
        });
      } else {
        var weeks = getWeeklyTrendsAnalytics(5);
        msg = formatTrendsMessage(weeks, {
          title: "📉 *Spending Trends* — Weekly",
          comparisonLabel: "vs Last Week"
        });
      }
      sendTelegramMessage(chatId, msg, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: { inline_keyboard: [buildTrendsToggleRow(mode), buildStatsBackRow()] }
      });
    }
  } catch (error) {
    console.error("Error in handleStatsCallback:", error.message, error.stack);
    sendTelegramMessage(chatId, "❌ *Error:* " + escapeMarkdown(error.message));
  }
}

function buildStatsBackRow() {
  return [{ text: "🔙 Back", callback_data: "stats_back" }];
}

// Toggle row inside Trends: shows a single button labelled with the OTHER
// granularity (i.e. when viewing weekly, button says "📊 Monthly" so the
// affordance is "switch to monthly"). Keeps the view stateless — no need
// to remember mode in callback data anywhere else, just encode the target.
function buildTrendsToggleRow(currentMode) {
  if (currentMode === "monthly") {
    return [{ text: "📅 Weekly", callback_data: "stats_trendsweekly" }];
  }
  return [{ text: "📊 Monthly", callback_data: "stats_trendsmonthly" }];
}
