/**
 * Dispatches the AI call to the configured provider.
 * Returns the response text, or null on failure.
 * Control which provider is used via the AI_PROVIDER constant in Constants.js.
 */
function callAI(prompt) {
  if (AI_PROVIDER === AI_PROVIDERS.GEMINI) {
    return callGemini(prompt);
  } else if (AI_PROVIDER === AI_PROVIDERS.AZURE_OPENAI) {
    return callAzureOpenAI(prompt);
  } else {
    throw new Error("Unknown AI_PROVIDER: " + AI_PROVIDER);
  }
}

/**
 * Calls the Google Gemini API and returns the response text.
 */
function callGemini(prompt) {
  var payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ]
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(GEMINI_BASE_URL + "?key=" + GEMINI_API_KEY, options);
  var jsonResponse = JSON.parse(response.getContentText());

  if (jsonResponse.candidates && jsonResponse.candidates.length > 0) {
    return jsonResponse.candidates[0].content.parts[0].text;
  }

  console.log("Gemini response did not contain candidates. Full response: " + JSON.stringify(jsonResponse));
  return null;
}

/**
 * Calls the Azure OpenAI chat completions endpoint and returns the response text.
 */
function callAzureOpenAI(prompt) {
  var url =
    AZURE_OPENAI_ENDPOINT +
    "/openai/deployments/" +
    AZURE_OPENAI_DEPLOYMENT_NAME +
    "/chat/completions?api-version=" +
    AZURE_OPENAI_API_VERSION;
  var payload = {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 800
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
    return jsonResponse.choices[0].message.content;
  }

  console.log("Azure OpenAI response did not contain choices. Full response: " + JSON.stringify(jsonResponse));
  return null;
}
