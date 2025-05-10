\
\'use strict\';

/**
 * Shows a transaction summary to the user via Telegram.
 * @param {string} chat_id The ID of the chat to send the summary to.
 */
function showTransactionSummary(chat_id) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
    let data = sheet.getDataRange().getValues();
    
    if (data.length <= 1) { // Only headers or empty
      sendTelegramMessage(chat_id, "📊 *No transactions found yet!*\\n\\nStart adding transactions to see your summary.");
      return;
    }
    
    data.shift(); // Remove header row
    
    let total_spent = 0;
    let total_received = 0;
    const category_spending = {};
    let transaction_count = 0;
    
    data.forEach(function(row) {
      const amount = parseFloat(row[3]) || 0; // Amount is in column D (index 3)
      const type = row[5]; // Transaction Type is in column F (index 5)
      const category = row[4] || "Uncategorized"; // Category is in column E (index 4)
      
      if (type === "Debit") {
        total_spent += amount;
        category_spending[category] = (category_spending[category] || 0) + amount;
      } else if (type === "Credit") {
        total_received += amount;
      }
      transaction_count++;
    });
    
    let message_content = `📊 *Transaction Summary*\\n\\n`;
    message_content += `📈 *Total Transactions:* ${transaction_count}\\n`;
    message_content += `💰 *Total Spent:* INR ${total_spent.toFixed(2)}\\n`;
    message_content += `💵 *Total Received:* INR ${total_received.toFixed(2)}\\n`;
    message_content += `📉 *Net Balance:* INR ${(total_received - total_spent).toFixed(2)}\\n\\n`;
    message_content += `📂 *Category-wise Spending:*\\n`;
    
    const sorted_categories = Object.keys(category_spending).sort(function(a, b) {
      return category_spending[b] - category_spending[a];
    });
    
    sorted_categories.forEach(function(category) {
      const amount = category_spending[category];
      if (total_spent > 0) { // Avoid division by zero if only credits exist
        const percentage = ((amount / total_spent) * 100).toFixed(1);
        message_content += `• ${escapeMarkdown(category)}: INR ${amount.toFixed(2)} (${percentage}%)\\n`;
      } else {
        message_content += `• ${escapeMarkdown(category)}: INR ${amount.toFixed(2)}\\n`;
      }
    });
    
    if (sorted_categories.length === 0 && total_spent === 0) {
        message_content += "No spending recorded yet.\\n";
    }

    sendTelegramMessage(chat_id, message_content);
  } catch (error) {
    console.error("Error in showTransactionSummary:", error);
    sendTelegramMessage(chat_id, "❌ *Error generating summary*\\n\\nPlease try again later.");
  }
}

/**
 * Shows recent transactions to the user via Telegram.
 * @param {string} chat_id The ID of the chat to send the recent transactions to.
 */
function showRecentTransactions(chat_id) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
    let data = sheet.getDataRange().getValues();
    
    if (data.length <= 1) { // Only headers or empty
      sendTelegramMessage(chat_id, "📅 *No transactions found yet!*\\n\\nStart adding transactions to see your history.");
      return;
    }
    
    data.shift(); // Remove header row
    
    // Get last 5 transactions, or fewer if not enough data
    const recent_transactions = data.slice(-5).reverse(); 
    
    let message_content = `📅 *Recent Transactions*\\n\\n`;
    
    if (recent_transactions.length === 0) {
        message_content += "No transactions to display.\\n";
    }

    recent_transactions.forEach(function(row) {
      // Assuming column indices: Date (1), Merchant (2), Amount (3), Category (4), Type (5)
      const date = row[1] ? escapeMarkdown(new Date(row[1]).toLocaleDateString('en-CA')) : "Unknown Date"; // Format date as YYYY-MM-DD
      const merchant = escapeMarkdown(row[2] || "Unknown Merchant"); 
      const amount = parseFloat(row[3]) || 0; 
      const type = escapeMarkdown(row[5] || "Unknown"); 
      const category = escapeMarkdown(row[4] || "Uncategorized"); 
      
      const emoji = type === "Debit" ? "💸" : "💰";
      message_content += `${emoji} *${date}*\\n`;
      message_content += `🏪 ${merchant}\\n`;
      message_content += `💰 INR ${amount.toFixed(2)}\\n`;
      if (category && category !== "Uncategorized" && category !== "N/A") {
        message_content += `📂 ${category}\\n`;
      }
      message_content += `\\n`;
    });
    
    sendTelegramMessage(chat_id, message_content);
  } catch (error) {
    console.error("Error in showRecentTransactions:", error);
    sendTelegramMessage(chat_id, "❌ *Error fetching recent transactions*\\n\\nPlease try again later.");
  }
}
