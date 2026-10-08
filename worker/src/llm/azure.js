// Azure OpenAI chat-completions client + a generic tool-calling loop.
//
// runToolLoop results:
//   { kind: "final", content, messages, iterations }
//   { kind: "suspend", toolCall, args, messages, iterations }  — a tool in
//       `suspendOn` (e.g. ask_user) was called; sibling tools already ran
//   { kind: "exhausted", messages, iterations }

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LlmError";
    this.status = status || 0;
  }
}

export function createLlm({ endpoint, apiKey, deployment, apiVersion, fetchImpl = (...args) => fetch(...args) }) {
  const url =
    String(endpoint || "").replace(/\/+$/, "") +
    "/openai/deployments/" +
    deployment +
    "/chat/completions?api-version=" +
    apiVersion;

  return {
    async chat({ messages, tools, maxTokens = 500 }) {
      const payload = { messages, max_completion_tokens: maxTokens };
      if (tools && tools.length) payload.tools = tools;
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": apiKey },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        throw new LlmError("Azure OpenAI network error: " + (e && e.message));
      }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !Array.isArray(json.choices) || json.choices.length === 0) {
        const detail = (json && json.error && json.error.message) || "no choices";
        throw new LlmError("Azure OpenAI " + res.status + ": " + detail, res.status);
      }
      return json.choices[0];
    }
  };
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}") || {};
  } catch (_) {
    return {};
  }
}

export async function runToolLoop(
  llm,
  { messages, tools, executeTool, maxIterations = 4, maxTokens, suspendOn = [], onIteration }
) {
  const history = messages.slice();
  for (let i = 0; i < maxIterations; i++) {
    if (onIteration) await onIteration(i);
    const choice = await llm.chat({ messages: history, tools, maxTokens });
    const msg = choice.message || {};
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      history.push({ role: "assistant", content: msg.content || "" });
      return { kind: "final", content: msg.content || "", messages: history, iterations: i + 1 };
    }

    history.push(msg);
    let suspended = null;
    for (const call of calls) {
      if (suspendOn.includes(call.function.name)) {
        if (!suspended) {
          suspended = call;
          continue;
        }
        // Every tool call needs a reply before the next turn.
        history.push({ role: "tool", tool_call_id: call.id, content: '{"error":"Only one question at a time."}' });
        continue;
      }
      let result;
      try {
        result = await executeTool(call.function.name, parseArgs(call.function.arguments));
      } catch (e) {
        result = { error: e && e.message };
      }
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result)
      });
    }
    if (suspended) {
      return {
        kind: "suspend",
        toolCall: suspended,
        args: parseArgs(suspended.function.arguments),
        messages: history,
        iterations: i + 1
      };
    }
  }
  return { kind: "exhausted", messages: history, iterations: maxIterations };
}

// Model output → JSON object, tolerating ```json fences. null if not JSON.
export function parseJsonContent(text) {
  const clean = String(text || "")
    .replace(/```json|```/g, "")
    .trim();
  if (clean.charAt(0) !== "{") return null;
  try {
    return JSON.parse(clean);
  } catch (_) {
    return null;
  }
}
