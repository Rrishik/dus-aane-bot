// Minimal Telegram Bot API client for the Worker.
//
// - Retries 429 (honouring retry_after) and 5xx/network errors, but never
//   sleeps longer than maxRetryWaitMs — a Worker shouldn't idle for a minute.
// - "message is not modified" (double taps, webhook retries) counts as
//   success and resolves to null.
// - Errors never include the request URL: it contains the bot token.

const SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export class TelegramError extends Error {
  constructor(method, code, description, retryAfter) {
    super("Telegram " + method + " failed (" + code + "): " + description);
    this.name = "TelegramError";
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter || null;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTelegram({
  token,
  fetchImpl = (...args) => fetch(...args),
  sleep = defaultSleep,
  maxAttempts = 3,
  maxRetryWaitMs = 5000
}) {
  if (!token) throw new Error("createTelegram: token is required");
  const base = "https://api.telegram.org/bot" + token + "/";

  async function request(method, init) {
    for (let attempt = 1; ; attempt++) {
      let res;
      let body = null;
      try {
        res = await fetchImpl(base + method, { method: "POST", ...init() });
        body = await res.json().catch(() => null);
      } catch (e) {
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new TelegramError(method, 0, "network error: " + (e && e.message));
      }
      if (body && body.ok) return body.result;

      const code = (body && body.error_code) || res.status;
      const description = (body && body.description) || "HTTP " + res.status;
      if (code === 400 && /message is not modified/i.test(description)) return null;

      const retryAfter = body && body.parameters && body.parameters.retry_after;
      if ((code === 429 || code >= 500) && attempt < maxAttempts) {
        const wait = code === 429 && retryAfter ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
        if (wait <= maxRetryWaitMs) {
          await sleep(wait);
          continue;
        }
      }
      throw new TelegramError(method, code, description, retryAfter);
    }
  }

  const call = (method, payload) =>
    request(method, () => ({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }));

  // parse_mode defaults to legacy Markdown, matching the Apps Script bot;
  // pass parse_mode: null for plain text.
  function withParseMode(opts) {
    const out = { ...opts };
    if (out.parse_mode === undefined) out.parse_mode = "Markdown";
    if (out.parse_mode === null) delete out.parse_mode;
    return out;
  }

  return {
    call,
    sendMessage: (chatId, text, opts = {}) => call("sendMessage", { chat_id: chatId, text, ...withParseMode(opts) }),
    editMessageText: (chatId, messageId, text, opts = {}) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...withParseMode(opts) }),
    editMessageReplyMarkup: (chatId, messageId, replyMarkup) =>
      call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
    answerCallbackQuery: (id, text = "", showAlert = false) =>
      call("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert }),
    sendChatAction: (chatId, action = "typing") => call("sendChatAction", { chat_id: chatId, action }),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId }),
    pinChatMessage: (chatId, messageId, disableNotification = true) =>
      call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: disableNotification }),
    getMe: () => call("getMe"),
    getChat: (chatId) => call("getChat", { chat_id: chatId }),
    getChatAdministrators: (chatId) => call("getChatAdministrators", { chat_id: chatId }),
    getChatMember: (chatId, userId) => call("getChatMember", { chat_id: chatId, user_id: userId }),
    setWebhook: (url, { secretToken, allowedUpdates } = {}) => {
      if (secretToken && !SECRET_TOKEN_PATTERN.test(secretToken)) {
        return Promise.reject(new Error("secret token may only contain A-Z, a-z, 0-9, _ and - (1-256 chars)"));
      }
      const payload = { url };
      if (secretToken) payload.secret_token = secretToken;
      if (allowedUpdates) payload.allowed_updates = allowedUpdates;
      return call("setWebhook", payload);
    },
    sendDocument: (chatId, { filename, content, mimeType = "text/csv", caption, replyMarkup }) =>
      request("sendDocument", () => {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("document", new Blob([content], { type: mimeType }), filename);
        if (caption) form.append("caption", caption);
        if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
        return { body: form };
      })
  };
}
