/**
 * Calls Azure OpenAI with tool/function calling support.
 * Returns the full API response object (not just text) so the caller can inspect tool_calls.
 * maxTokens controls max_completion_tokens (default 500).
 */
function callAIWithTools(messages, tools, maxTokens) {
  var url =
    AZURE_OPENAI_ENDPOINT +
    "/openai/deployments/" +
    AZURE_OPENAI_DEPLOYMENT_NAME +
    "/chat/completions?api-version=" +
    AZURE_OPENAI_API_VERSION;
  var payload = {
    messages: messages,
    tools: tools,
    max_completion_tokens: maxTokens || 500
  };
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "api-key": AZURE_OPENAI_API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var jsonResponse = JSON.parse(response.getContentText());

  if (jsonResponse.choices && jsonResponse.choices.length > 0) {
    return jsonResponse;
  }

  console.error("callAIWithTools error:", response.getContentText());
  return null;
}
