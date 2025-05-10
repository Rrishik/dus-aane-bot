// Method to handle the callback queries sent from the Telegram message reply buttons.
function handleCallbackQuery(update) {
  if (update.callback_query) {
    var callback_query_id = update.callback_query.id;
    var chat_id = update.callback_query.message.chat.id;
    var message_id = update.callback_query.message.message_id;
    var message_text = update.callback_query.message.text;
    var data = update.callback_query.data; // Example: "personal_5" or "split_8"
    console.log([chat_id, message_id, data]);
    if (data) {
      var action = data.split("_")[0]; // "personal" or "split"
      var toggle_action = action === "personal" ? "split" : "personal"; // Toggle between personal and split
      var row_number = parseInt(data.split("_")[1]); // Extract row number

      // Update the existing row in Google Sheets
      updateGoogleSheetCell(SHEET_ID, row_number, SPLIT_COLUMN, action === "personal" ? "Personal" : "Split");

      var options = {
        parse_mode: "Markdown", // Changed from parseMode
        reply_markup: getReplyMarkup(`🔄 Update to ${toggle_action}`, `${toggle_action}_${row_number}`), // Changed from replyMarkup
        message_id: message_id // Changed from messageId
      };
      var message = `✅ *Marked ${action}*

${message_text}`;
      sendTelegramMessage(chat_id, message, options);

      // Acknowledge callback to Telegram
      answerCallbackQuery(callback_query_id);
    }
  }
}