// Per-request context: D1, Telegram and LLM clients, clock. Clients are built
// lazily so routes that don't need them don't require their secrets.
import { createTelegram } from "../telegram/client.js";
import { createLlm } from "../llm/azure.js";

export function createContext(env, overrides = {}) {
  let tg = overrides.tg || null;
  let llm = overrides.llm || null;
  return {
    env,
    db: overrides.db || env.DB,
    now: overrides.now || (() => Date.now()),
    fetch: overrides.fetch || ((...args) => fetch(...args)),
    adminChatId: env.ADMIN_CHAT_ID ? String(env.ADMIN_CHAT_ID) : null,
    get tg() {
      if (!tg) tg = createTelegram({ token: env.BOT_TOKEN });
      return tg;
    },
    get llm() {
      if (!llm) {
        llm = createLlm({
          endpoint: env.AZURE_OPENAI_ENDPOINT,
          apiKey: env.AZURE_OPENAI_API_KEY,
          deployment: env.AZURE_OPENAI_DEPLOYMENT_NAME,
          apiVersion: env.AZURE_OPENAI_API_VERSION
        });
      }
      return llm;
    }
  };
}
