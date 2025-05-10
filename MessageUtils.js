function getTransactionMessageAsString(transaction_details, user) {
  // Escape all transaction details
  var amount = escapeMarkdown(transaction_details.amount);
  var date = escapeMarkdown(transaction_details.transaction_date);
  var merchant = escapeMarkdown(transaction_details.merchant);
  var category = escapeMarkdown(transaction_details.category);
  var user = escapeMarkdown(user);

  var message = `💸 *INR ${amount} ${transaction_details.transaction_type}ed* :
🗓 *Date:* ${date}
🏪 *Merchant:* ${merchant}
${category ? `📂 *Category:* ${category}\n` : ""}
👤 *By:* ${user}

`;
  return message;
}


function sendTransactionMessage(transaction_details, row_number, user) {
  var message = getTransactionMessageAsString(transaction_details, user);
  var reply_markup_data = buildReplyMarkup("✂️ Want to split ?", `split_${row_number}`);
  var options = {
    parse_mode: "Markdown",
    reply_markup: reply_markup_data
  };
  sendTelegramMessage(CHAT_ID, message, options);
  console.log("Telegram message sent successfully.");
}
