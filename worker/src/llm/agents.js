// Zero-dependency multi-agent handoff runner on top of Azure OpenAI (azure.js).
//
// Each agent owns a focused instruction prompt, tool list, and optional
// 1-way `handoffs` to specialist agents. A root Triage agent sees only its
// `route_to_<agent>` tools; once it transfers control, the specialist's
// system prompt and tools take over in the same turn without bouncing back.

const HANDOFF_PREFIX = "route_to_";
const MAX_HANDOFFS_PER_TURN = 2;

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}") || {};
  } catch (_) {
    return {};
  }
}

export function defineAgent(spec) {
  if (!spec || !spec.name) throw new Error("defineAgent: name is required");
  return {
    name: spec.name,
    description: spec.description || "",
    instructions: spec.instructions || "",
    tools: spec.tools || [],
    executeTool: spec.executeTool || (async (name) => ({ error: "Unknown tool: " + name })),
    handoffs: spec.handoffs || [],
    quotaExempt: !!spec.quotaExempt
  };
}

function indexAgents(root) {
  const map = {};
  const stack = [root];
  while (stack.length) {
    const a = stack.pop();
    if (!a || map[a.name]) continue;
    map[a.name] = a;
    for (const h of a.handoffs || []) stack.push(h);
  }
  return map;
}

function handoffToolsFor(agent, handoffsUsed) {
  if (handoffsUsed >= MAX_HANDOFFS_PER_TURN) return [];
  return (agent.handoffs || []).map((target) => ({
    type: "function",
    function: {
      name: HANDOFF_PREFIX + target.name,
      description: "Transfer this conversation to " + target.name + ": " + target.description,
      parameters: { type: "object", properties: {}, required: [] }
    }
  }));
}

function applySystemPrompt(history, agent, runCtx) {
  const content = typeof agent.instructions === "function" ? agent.instructions(runCtx) : agent.instructions;
  if (history.length > 0 && history[0].role === "system") {
    history[0] = { role: "system", content };
  } else {
    history.unshift({ role: "system", content });
  }
}

// Results mirror runToolLoop, adding `activeAgent` and `quotaExempt`:
//   { kind: "final", content, messages, activeAgent, quotaExempt, iterations }
//   { kind: "suspend", toolCall, args, messages, activeAgent, quotaExempt, iterations }
//   { kind: "exhausted", messages, activeAgent, quotaExempt, iterations }
export async function runAgentLoop(
  llm,
  {
    rootAgent,
    activeAgent = null,
    messages = [],
    runCtx = {},
    maxIterations = 6,
    maxTokens = 800,
    suspendOn = ["ask_user"],
    onIteration
  }
) {
  const registry = indexAgents(rootAgent);
  let current = (activeAgent && registry[activeAgent]) || rootAgent;
  const history = messages.slice();
  let handoffsUsed = 0;
  let steps = 0;
  let totalCalls = 0;

  while (steps < maxIterations) {
    applySystemPrompt(history, current, runCtx);
    if (onIteration) await onIteration(totalCalls, current);
    const tools = [...(current.tools || []), ...handoffToolsFor(current, handoffsUsed)];
    const choice = await llm.chat({ messages: history, tools, maxTokens });
    totalCalls++;
    const msg = choice.message || {};
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      history.push({ role: "assistant", content: msg.content || "" });
      return {
        kind: "final",
        content: msg.content || "",
        messages: history,
        activeAgent: current.name,
        quotaExempt: !!current.quotaExempt,
        iterations: totalCalls
      };
    }

    history.push(msg);
    let suspended = null;
    let handedOffOnly = true;

    for (const call of calls) {
      const fnName = call.function && call.function.name;
      if (fnName && fnName.startsWith(HANDOFF_PREFIX)) {
        const targetName = fnName.slice(HANDOFF_PREFIX.length);
        const target = (current.handoffs || []).find((h) => h.name === targetName);
        if (target && handoffsUsed < MAX_HANDOFFS_PER_TURN) {
          current = target;
          handoffsUsed++;
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ routed_to: target.name })
          });
        } else {
          handedOffOnly = false;
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "Cannot route to " + targetName })
          });
        }
        continue;
      }

      handedOffOnly = false;
      if (suspendOn.includes(fnName)) {
        if (!suspended) {
          suspended = call;
          continue;
        }
        history.push({ role: "tool", tool_call_id: call.id, content: '{"error":"Only one question at a time."}' });
        continue;
      }

      let result;
      try {
        result = await current.executeTool(fnName, parseArgs(call.function.arguments), runCtx);
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
        activeAgent: current.name,
        quotaExempt: !!current.quotaExempt,
        iterations: totalCalls
      };
    }

    // Pure handoff step swaps specialists without eating the specialist's tool budget.
    if (!handedOffOnly) steps++;
  }

  return {
    kind: "exhausted",
    messages: history,
    activeAgent: current.name,
    quotaExempt: !!current.quotaExempt,
    iterations: totalCalls
  };
}
