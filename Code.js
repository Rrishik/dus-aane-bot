// Webhook endpoint for the Telegram bot
// This function is triggered when a POST request is made to the script URL
function doPost(e) {
  console.log("Webhook data received:", e.postData.contents);
  var update = JSON.parse(e.postData.contents);
  
  if (update.callback_query) {
    handleCallbackQuery(update); // Keep as is, `update` is a common name for the whole object
    console.log("Callback processed!");
  }
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}


// Function for time based triggers
function triggerEmailProcessing() {
  console.log("Triggered email processing started");
  extractTransactionsWithGemini();
  console.log("Triggered email processing completed");
}


