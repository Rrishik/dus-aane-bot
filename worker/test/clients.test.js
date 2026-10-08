import { describe, it, expect, vi } from "vitest";
import { createTelegram, TelegramError } from "../src/telegram/client.js";
import { createLlm, runToolLoop, parseJsonContent, LlmError } from "../src/llm/azure.js";

const json = (status, body) => new Response(JSON.stringify(body), { status });

function telegram(responses, opts) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const tg = createTelegram(Object.assign({ token: "123:SECRET", fetchImpl, sleep }, opts));
  return { tg, calls, sleep };
}

describe("telegram client", () => {
  it("posts JSON and defaults parse_mode to Markdown", async () => {
    const { tg, calls } = telegram([json(200, { ok: true, result: { message_id: 7 } })]);
    expect(await tg.sendMessage(1, "hi", { reply_markup: { inline_keyboard: [] } })).toEqual({ message_id: 7 });
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      chat_id: 1,
      text: "hi",
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [] }
    });
  });

  it("parse_mode: null sends plain text", async () => {
    const { tg, calls } = telegram([json(200, { ok: true, result: true })]);
    await tg.sendMessage(1, "a_b", { parse_mode: null });
    expect(JSON.parse(calls[0].init.body).parse_mode).toBeUndefined();
  });

  it("treats 'message is not modified' as success", async () => {
    const { tg } = telegram([
      json(400, { ok: false, error_code: 400, description: "Bad Request: message is not modified" })
    ]);
    await expect(tg.editMessageReplyMarkup(1, 2, {})).resolves.toBeNull();
  });

  it("retries 429 honouring retry_after, then succeeds", async () => {
    const { tg, sleep } = telegram([
      json(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } }),
      json(200, { ok: true, result: true })
    ]);
    await expect(tg.sendChatAction(1)).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up instead of waiting longer than maxRetryWaitMs", async () => {
    const { tg, sleep } = telegram([
      json(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 60 } })
    ]);
    const err = await tg.sendMessage(1, "x").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.retryAfter).toBe(60);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries network errors and 5xx with backoff", async () => {
    const { tg, sleep } = telegram([
      new Error("socket hang up"),
      json(502, { ok: false, error_code: 502, description: "Bad Gateway" }),
      json(200, { ok: true, result: { id: 1 } })
    ]);
    await expect(tg.getMe()).resolves.toEqual({ id: 1 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it("never leaks the bot token in errors", async () => {
    const { tg } = telegram([json(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" })]);
    const err = await tg.sendMessage(1, "x").catch((e) => e);
    expect(err.message).toBe("Telegram sendMessage failed (400): Bad Request: chat not found");
    expect(err.message).not.toContain("SECRET");
  });

  it("setWebhook validates the secret token before calling Telegram", async () => {
    const { tg, calls } = telegram([json(200, { ok: true, result: true })]);
    await expect(tg.setWebhook("https://w", { secretToken: "bad token!" })).rejects.toThrow(/A-Z/);
    expect(calls).toHaveLength(0);
    await tg.setWebhook("https://w", { secretToken: "ok_token-1", allowedUpdates: ["message"] });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      url: "https://w",
      secret_token: "ok_token-1",
      allowed_updates: ["message"]
    });
  });

  it("sendDocument uploads multipart form data", async () => {
    const { tg, calls } = telegram([json(200, { ok: true, result: { message_id: 9 } })]);
    await tg.sendDocument(1, { filename: "export.csv", content: "a,b\n1,2\n", caption: "Your export" });
    const form = calls[0].init.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("1");
    expect(form.get("caption")).toBe("Your export");
    expect(await form.get("document").text()).toBe("a,b\n1,2\n");
  });
});

function llmWith(replies) {
  const fetchImpl = vi.fn(async () => replies.shift());
  const llm = createLlm({
    endpoint: "https://azure.example/",
    apiKey: "key",
    deployment: "gpt",
    apiVersion: "2024-08-01-preview",
    fetchImpl
  });
  return { llm, fetchImpl };
}
const choice = (message) => json(200, { choices: [{ message }] });

describe("azure llm client", () => {
  it("calls the deployment URL with the api-key header and tools", async () => {
    const { llm, fetchImpl } = llmWith([choice({ content: "hi" })]);
    await llm.chat({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function" }], maxTokens: 300 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://azure.example/openai/deployments/gpt/chat/completions?api-version=2024-08-01-preview");
    expect(init.headers["api-key"]).toBe("key");
    expect(JSON.parse(init.body)).toMatchObject({ max_completion_tokens: 300, tools: [{ type: "function" }] });
  });

  it("throws LlmError with the API message on failures", async () => {
    const { llm } = llmWith([json(429, { error: { message: "Rate limit" } })]);
    const err = await llm.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/Rate limit/);
  });
});

describe("runToolLoop", () => {
  const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: args } });

  it("executes tools, feeds results back, and returns the final answer", async () => {
    const { llm } = llmWith([
      choice({ role: "assistant", tool_calls: [toolCall("c1", "lookup", '{"q":"swiggy"}')] }),
      choice({ role: "assistant", content: "Food & Dining" })
    ]);
    const executeTool = vi.fn(async (name, args) => ({ name, got: args.q }));
    const out = await runToolLoop(llm, { messages: [{ role: "user", content: "?" }], tools: [], executeTool });
    expect(out).toMatchObject({ kind: "final", content: "Food & Dining", iterations: 2 });
    expect(executeTool).toHaveBeenCalledWith("lookup", { q: "swiggy" });
    expect(out.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"name":"lookup","got":"swiggy"}' });
  });

  it("suspends on ask_user after running sibling tools", async () => {
    const { llm } = llmWith([
      choice({
        role: "assistant",
        tool_calls: [toolCall("c1", "search", "{}"), toolCall("c2", "ask_user", '{"question":"Which month?"}')]
      })
    ]);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const out = await runToolLoop(llm, { messages: [], tools: [], executeTool, suspendOn: ["ask_user"] });
    expect(out.kind).toBe("suspend");
    expect(out.args).toEqual({ question: "Which month?" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(out.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("tolerates malformed arguments and tool exceptions; stops at maxIterations", async () => {
    const loop = () => choice({ role: "assistant", tool_calls: [toolCall("c", "t", "{not json")] });
    const { llm } = llmWith([loop(), loop()]);
    const executeTool = vi.fn(async (_n, args) => {
      expect(args).toEqual({});
      throw new Error("boom");
    });
    const out = await runToolLoop(llm, { messages: [], tools: [], executeTool, maxIterations: 2 });
    expect(out.kind).toBe("exhausted");
    expect(out.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      '{"error":"boom"}',
      '{"error":"boom"}'
    ]);
  });

  it("parseJsonContent strips fences and rejects non-JSON", () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent("Sorry")).toBeNull();
    expect(parseJsonContent("{broken")).toBeNull();
  });
});
