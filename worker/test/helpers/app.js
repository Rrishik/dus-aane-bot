// Fakes for app-level tests: Telegram, a scripted LLM, and a seeded context.
import { createTestD1 } from "./d1.js";
import { createContext } from "../../src/app/context.js";
import { registerEmail, activateTenant, createGroup, setTenantStatus } from "../../src/db/tenants.js";

export const NOW = Date.UTC(2026, 9, 7, 8, 0); // 2026-10-07 13:30 IST

export function fakeTelegram() {
  const calls = [];
  let nextId = 100;
  const record =
    (method, result = () => true) =>
    async (...args) => {
      calls.push({ method, args });
      return result(...args);
    };
  return {
    calls,
    of: (method) => calls.filter((c) => c.method === method),
    sendMessage: record("sendMessage", () => ({ message_id: nextId++ })),
    editMessageText: record("editMessageText"),
    editMessageReplyMarkup: record("editMessageReplyMarkup"),
    answerCallbackQuery: record("answerCallbackQuery"),
    sendChatAction: record("sendChatAction"),
    deleteMessage: record("deleteMessage"),
    pinChatMessage: record("pinChatMessage"),
    sendDocument: record("sendDocument", () => ({ message_id: nextId++ })),
    getMe: record("getMe", () => ({ id: 999000, username: "dusaanebot" })),
    getChat: record("getChat", () => ({})),
    getChatAdministrators: record("getChatAdministrators", () => []),
    getChatMember: record("getChatMember", () => ({}))
  };
}

// replies: model message contents (strings), full message objects, or Errors.
export function fakeLlm(replies = []) {
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      calls.push(messages);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error("fakeLlm: no scripted reply");
      return { message: typeof r === "string" ? { role: "assistant", content: r } : r };
    }
  };
}

export function testContext({ now = NOW, llmReplies, env = {} } = {}) {
  const db = createTestD1();
  const tg = fakeTelegram();
  const llm = fakeLlm(llmReplies);
  let clock = now;
  const ctx = createContext({ ADMIN_CHAT_ID: "999", ...env }, { db, tg, llm, now: () => clock });
  ctx.advance = (ms) => {
    clock += ms;
  };
  return ctx;
}

export async function seedTenant(ctx, id, { email, name, status = "active" } = {}) {
  await registerEmail(ctx.db, id, email || id + "@x.com", name || "U" + id, NOW);
  if (status === "active") await activateTenant(ctx.db, id);
  else if (status !== "pending") await setTenantStatus(ctx.db, id, status);
  return ctx.db.prepare("SELECT * FROM tenants WHERE id = ?").bind(String(id)).first();
}

export async function seedGroup(ctx, id, members, name = "Flat") {
  await createGroup(ctx.db, { id, name, adminId: members[0], members, now: NOW });
}

export const llmTxn = (o) =>
  JSON.stringify({
    transaction_date: "2026-10-07",
    merchant: "Swiggy",
    amount: 250,
    currency: "INR",
    category: "Food & Dining",
    transaction_type: "Debit",
    ...o
  });
