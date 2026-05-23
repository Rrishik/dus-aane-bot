// ─── Tool Definitions (OpenAI function calling format) ───────────────

var ASK_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_spending_summary",
      description:
        "Get total spending and income summary for a date range. Returns debit/credit totals per currency and transaction count.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format" }
        },
        required: ["start_date", "end_date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_category_breakdown",
      description:
        "Get spending breakdown by category for a date range. Returns each category with amount, currency, and transaction count.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format" }
        },
        required: ["start_date", "end_date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_top_merchants",
      description: "Get top merchants by spending amount for a date range.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format" },
          limit: { type: "number", description: "Number of merchants to return. Default 5." }
        },
        required: ["start_date", "end_date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_user_spend",
      description: "Get per-user spending totals for a date range. Shows how much each user spent in debits.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format" }
        },
        required: ["start_date", "end_date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_transactions",
      description:
        "Search for specific transactions. Use when the user asks about a specific merchant, category, or amount range. All parameters are optional filters.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format" },
          merchant: { type: "string", description: "Merchant name to search for (case-insensitive partial match)" },
          category: { type: "string", description: "Category to filter by (exact match)" },
          user: { type: "string", description: "Username to filter by (partial match)" },
          min_amount: { type: "number", description: "Minimum transaction amount" },
          max_amount: { type: "number", description: "Maximum transaction amount" },
          transaction_type: { type: "string", description: "Filter by transaction type: Debit or Credit" },
          limit: { type: "number", description: "Max results to return. Default 10." }
        },
        required: []
      }
    }
  },
  {
    // Suspends the loop and prompts the user for a free-text reply. The reply
    // arrives via a Telegram reply-to-message gesture and is resumed by the
    // caller as the tool response. Use sparingly — prefer answering with the
    // data already available.
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a short clarifying question and wait for a free-text reply. Use when a required parameter is genuinely missing and cannot be inferred from prior context, OR when you need the user to pick one row before calling a mutation tool (update_transaction, split_transaction). For pure read-only answers, do NOT use ask_user for disambiguation — just present the options inline in your normal reply instead. Never use for confirmations or stylistic choices.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask. Max 200 chars. Plain text, no markdown." }
        },
        required: ["question"]
      }
    }
  },
  {
    // Mutation tool: rewrite the category, merchant tag, or transaction type
    // of a specific row. Identifier is the `transaction_id` surfaced by
    // search_transactions. Category updates additionally teach the bot the
    // merchant→category mapping (same as the inline 📂 picker).
    type: "function",
    function: {
      name: "update_transaction",
      description:
        "Update a single transaction's category, merchant tag, or transaction type. Identify the row via transaction_id from search_transactions. Use only when the user explicitly asks to change a transaction — never speculatively. Confirm any ambiguity with ask_user first.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: { type: "string", description: "The transaction_id from search_transactions output." },
          category: {
            type: "string",
            description:
              "New category. Must be one of the listed debit or credit categories appropriate to the row's type."
          },
          merchant: { type: "string", description: "New merchant / tag name. Short, 1-18 chars." },
          transaction_type: { type: "string", description: "New transaction type: Debit or Credit." }
        },
        required: ["transaction_id"]
      }
    }
  },
  {
    // Mutation tool: split an existing personal transaction into a group's
    // share rows. Mirrors the inline 👥 split flow but is driven from /ask.
    // The transaction must not already be split (re-split requires undo
    // first, same as the UI). Posts to the group chat + writes the group
    // sheet rows.
    type: "function",
    function: {
      name: "split_transaction",
      description:
        "Split a personal transaction into a group. Posts the split notification in the group chat and writes share rows to the group sheet. If the user has multiple groups, call get_groups first or ask_user to disambiguate. Never split a transaction that already shows split=true in search results.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: { type: "string", description: "The transaction_id from search_transactions output." },
          group_chat_id: {
            type: "string",
            description: "The group's chat_id from get_groups output. Optional if the user has only one group."
          },
          mode: {
            type: "string",
            description:
              "Split mode: '50' (50/50 between 2 members), 'p100' (the other 2-member owes 100%), 'all' (even across all members), 'wN' (everyone except member index N), 'iN' (just payer + member index N). Member index N is the 0-based index in the group's members list from get_groups."
          }
        },
        required: ["transaction_id", "mode"]
      }
    }
  },
  {
    // Lightweight enumerator: returns the groups the current user is in so
    // the LLM can pick a `group_chat_id` for split_transaction. Members are
    // returned with 0-based indices to match the `wN` / `iN` mode syntax.
    type: "function",
    function: {
      name: "get_groups",
      description:
        "List the active groups the current user is a member of. Use before split_transaction when the user hasn't specified the group, or when you need member indices for 'wN' / 'iN' split modes.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

// ─── Tool Executor ───────────────────────────────────────────────────
//
// `ctx` carries per-request context the executors need beyond the LLM args:
//   - `chatId`: the personal tenant chat id, required by the mutation tools
//     (update_transaction, split_transaction, get_groups) for tenant /
//     group resolution. Pure-read tools ignore it.

function executeAskTool(toolName, args, allTransactions, ctx) {
  ctx = ctx || {};
  var all = allTransactions;
  var filtered = all;

  if (args.start_date && args.end_date) {
    filtered = filterByDateRange(all, args.start_date, args.end_date);
  } else if (args.start_date) {
    var start = new Date(args.start_date);
    start.setHours(0, 0, 0, 0);
    filtered = filtered.filter(function (t) {
      return t.date >= start;
    });
  } else if (args.end_date) {
    var end = new Date(args.end_date);
    end.setHours(23, 59, 59, 999);
    filtered = filtered.filter(function (t) {
      return t.date <= end;
    });
  }

  var debits = filtered.filter(function (t) {
    return t.type === "Debit";
  });
  var credits = filtered.filter(function (t) {
    return t.type === "Credit";
  });

  switch (toolName) {
    case "get_spending_summary":
      return {
        total_transactions: filtered.length,
        debit_count: debits.length,
        credit_count: credits.length,
        debits_by_currency: sumByCurrency(debits),
        credits_by_currency: sumByCurrency(credits)
      };

    case "get_category_breakdown":
      return {
        categories: aggregateByField(debits, "category")
      };

    case "get_top_merchants":
      return {
        merchants: aggregateByField(debits, "merchant").slice(0, args.limit || 5)
      };

    case "get_user_spend":
      return { users: aggregateByUser(debits) };

    case "search_transactions":
      return execSearchTransactions(filtered, args);

    case "update_transaction":
      return execUpdateTransaction(all, args);

    case "get_groups":
      return execGetGroups(ctx);

    case "split_transaction":
      return execSplitTransaction(all, args, ctx);

    default:
      return { error: "Unknown tool: " + toolName };
  }
}

function execSearchTransactions(filtered, args) {
  var results = filtered;

  if (args.merchant) {
    var m = args.merchant.toLowerCase();
    results = results.filter(function (t) {
      return t.merchant.toLowerCase().indexOf(m) !== -1;
    });
  }
  if (args.category) {
    var c = args.category;
    results = results.filter(function (t) {
      return t.category === c;
    });
  }
  if (args.user) {
    var u = args.user.toLowerCase();
    results = results.filter(function (t) {
      return t.user.toLowerCase().indexOf(u) !== -1;
    });
  }
  if (args.transaction_type) {
    var tt = args.transaction_type;
    results = results.filter(function (t) {
      return t.type === tt;
    });
  }
  if (args.min_amount !== undefined) {
    results = results.filter(function (t) {
      return t.amount >= args.min_amount;
    });
  }
  if (args.max_amount !== undefined) {
    results = results.filter(function (t) {
      return t.amount <= args.max_amount;
    });
  }

  var limit = args.limit || 10;
  results = results.slice(-limit);

  return {
    count: results.length,
    transactions: results.map(function (t) {
      var tz = Session.getScriptTimeZone();
      return {
        // Stable id — pass this back to update_transaction / split_transaction.
        transaction_id: t.messageId,
        date: Utilities.formatDate(t.date, tz, "yyyy-MM-dd"),
        merchant: t.merchant,
        amount: t.amount,
        currency: t.currency,
        category: t.category,
        type: t.type,
        user: t.user
      };
    })
  };
}

// ─── Mutation tool executors ─────────────────────────────────────────

// Look up the personal-sheet row for `transactionId` via the indexed lookup
// shared with the callback dispatchers. Returns -1 when not found. Wraps
// the global so tests can stub the lookup independently.
function _findRowForTransactionId(transactionId) {
  if (!transactionId) return -1;
  return findRowByColumnValue(MESSAGE_ID_COLUMN, String(transactionId));
}

function execUpdateTransaction(allTransactions, args) {
  if (!args || !args.transaction_id) {
    return { ok: false, error: "transaction_id is required" };
  }
  // Match against the in-memory snapshot so we know the prior values without
  // re-reading the sheet. The LLM should only pass ids it just observed.
  var match = null;
  for (var i = 0; i < allTransactions.length; i++) {
    if (allTransactions[i].messageId === args.transaction_id) {
      match = allTransactions[i];
      break;
    }
  }
  if (!match) return { ok: false, error: "Transaction not found for transaction_id: " + args.transaction_id };

  var rowNumber = _findRowForTransactionId(args.transaction_id);
  if (rowNumber < 0) return { ok: false, error: "Sheet row missing for that transaction (was it deleted?)" };

  var changes = [];

  if (args.category !== undefined && args.category !== null && args.category !== "") {
    var valid = match.type === "Credit" ? CREDIT_CATEGORIES : CATEGORIES;
    if (valid.indexOf(args.category) === -1) {
      return {
        ok: false,
        error: "Invalid category for a " + (match.type || "Debit") + " transaction. Valid: " + valid.join(", ")
      };
    }
    var catRes = updateGoogleSheetCellWithFeedback(rowNumber, CATEGORY_COLUMN, args.category, match.category);
    if (!catRes.success) return { ok: false, error: catRes.message || "Category update failed" };
    // Teach the bot the merchant→category mapping so future emails default
    // to the same pick — mirrors the inline 📂 callback behaviour.
    if (match.merchant) {
      try {
        setCategoryOverride(match.merchant, args.category);
      } catch (_) {}
    }
    changes.push({ field: "category", from: match.category, to: args.category });
  }

  if (args.merchant !== undefined && args.merchant !== null && args.merchant !== "") {
    var newTag = String(args.merchant).trim();
    if (!newTag || newTag.length > TAG_MAX_LEN) {
      return { ok: false, error: "merchant must be 1–" + TAG_MAX_LEN + " characters" };
    }
    var mRes = updateGoogleSheetCellWithFeedback(rowNumber, MERCHANT_COLUMN, newTag, match.merchant);
    if (!mRes.success) return { ok: false, error: mRes.message || "Merchant update failed" };
    changes.push({ field: "merchant", from: match.merchant, to: newTag });
  }

  if (args.transaction_type !== undefined && args.transaction_type !== null && args.transaction_type !== "") {
    var t = String(args.transaction_type);
    if (t !== "Debit" && t !== "Credit") {
      return { ok: false, error: "transaction_type must be 'Debit' or 'Credit'" };
    }
    var tRes = updateGoogleSheetCellWithFeedback(rowNumber, TRANSACTION_TYPE_COLUMN, t, match.type);
    if (!tRes.success) return { ok: false, error: tRes.message || "Type update failed" };
    changes.push({ field: "transaction_type", from: match.type, to: t });
  }

  if (changes.length === 0) {
    return { ok: false, error: "Nothing to update — pass at least one of: category, merchant, transaction_type" };
  }
  return { ok: true, transaction_id: args.transaction_id, changes: changes };
}

function execGetGroups(ctx) {
  if (!ctx || !ctx.chatId) return { ok: false, error: "Caller chat id unavailable", groups: [] };
  var groups;
  try {
    groups = findGroupsForMember(ctx.chatId);
  } catch (e) {
    return { ok: false, error: "Could not load groups: " + (e && e.message), groups: [] };
  }
  return {
    ok: true,
    count: groups.length,
    groups: groups.map(function (g) {
      var members = (g.group_members || []).map(function (id, idx) {
        var t = null;
        try {
          t = findTenantByChatId(id);
        } catch (_) {}
        return { index: idx, chat_id: String(id), name: (t && t.name) || String(id) };
      });
      return {
        chat_id: String(g.chat_id),
        name: g.name || "",
        primary_currency: g.primary_currency || "INR",
        members: members
      };
    })
  };
}

function execSplitTransaction(allTransactions, args, ctx) {
  if (!ctx || !ctx.chatId) return { ok: false, error: "Caller chat id unavailable" };
  if (!args || !args.transaction_id) return { ok: false, error: "transaction_id is required" };
  if (!args.mode) return { ok: false, error: "mode is required (e.g. '50', 'all', 'p100', 'wN', 'iN')" };

  // Validate the txn exists in the snapshot. Lets us refuse early on a bad
  // id without paying for the lock / group lookups inside recordGroupSplit.
  var match = null;
  for (var i = 0; i < allTransactions.length; i++) {
    if (allTransactions[i].messageId === args.transaction_id) {
      match = allTransactions[i];
      break;
    }
  }
  if (!match) return { ok: false, error: "Transaction not found for transaction_id: " + args.transaction_id };

  // Disambiguate the group when the LLM omitted it. If the user is in
  // exactly one group, auto-pick; otherwise refuse and let the LLM call
  // get_groups + ask_user.
  var groupChatId = args.group_chat_id;
  if (!groupChatId) {
    var groups = [];
    try {
      groups = findGroupsForMember(ctx.chatId);
    } catch (_) {}
    if (groups.length === 1) {
      groupChatId = String(groups[0].chat_id);
    } else if (groups.length === 0) {
      return { ok: false, error: "You are not in any active group." };
    } else {
      return {
        ok: false,
        error: "Multiple groups available — call get_groups and pass group_chat_id explicitly."
      };
    }
  }

  var result;
  try {
    result = recordGroupSplit({
      emailMessageId: args.transaction_id,
      groupChatId: groupChatId,
      mode: args.mode,
      payerChatId: ctx.chatId
    });
  } catch (e) {
    return { ok: false, error: "Split failed: " + (e && e.message) };
  }
  if (!result || !result.ok) {
    return { ok: false, error: (result && result.error) || "Split failed" };
  }
  return {
    ok: true,
    transaction_id: args.transaction_id,
    group_chat_id: groupChatId,
    merchant: result.merchant,
    amount: result.amount,
    currency: result.currency,
    category: result.category,
    holders: result.holders,
    shares: result.shares
  };
}

// ─── Ask System Prompt ───────────────────────────────────────────────

function getAskSystemPrompt() {
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
  var defaultStart = Utilities.formatDate(tenDaysAgo, tz, "yyyy-MM-dd");

  return (
    "You are a concise spending analyst for a shared expense tracker used by two people.\n" +
    "Today's date is " +
    today +
    ".\n\n" +
    "You have tools to query expense data. Use them to answer questions about spending, transactions, and settlements.\n\n" +
    "Rules:\n" +
    "- When no date range is specified, default to last 10 days: " +
    defaultStart +
    " to " +
    today +
    "\n" +
    "- When no user is specified, include all users combined\n" +
    "- Format currency amounts with the symbol and a rounded whole number, no thousands separator or decimals (e.g. ₹1234, $550, €99). Currency symbols: INR=₹, USD=$, EUR=€, GBP=£, JPY/CNY=¥, AUD=A$, CAD=C$, SGD=S$, HKD=HK$, NZD=NZ$. For currencies not listed here, use the 3-letter code prefix instead (e.g. AED 500). Show INR prominently; other currencies only if present\n" +
    "- Keep answers short — 2-5 sentences max. Use bullet points for lists\n" +
    "- Do NOT use Markdown bold/italic formatting\n" +
    "- If the question is unrelated to expenses or transactions, politely decline\n" +
    "- If a tool returns empty results, say so clearly — do not guess or hallucinate\n" +
    "- You may call multiple tools to answer complex questions\n" +
    "- Available debit categories: " +
    CATEGORIES.join(", ") +
    "\n" +
    "- Available credit categories: " +
    CREDIT_CATEGORIES.join(", ") +
    "\n" +
    "- Correct likely typos in merchant names before searching (e.g., flipart → flipkart, swiggi → swiggy, amzn → amazon)\n" +
    "- Use short/common merchant name for search — the data may have suffixes like _mws_merch\n" +
    "- Prefer answering with the data you already have. For read-only answers, call ask_user only when a required parameter is genuinely missing and cannot be inferred — never for confirmation or stylistic choices. For mutation tools, see below.\n" +
    "- CRITICAL: A final text answer MUST be a complete statement, never a question to the user. If your final answer would ask the user anything (e.g. 'Which one?', 'Want a breakdown?', 'Should I update X?'), STOP — call the ask_user tool with that question instead. A final text containing '?' that expects a user response is a bug: the user's reply gets orphaned because there is no resume hook attached to plain text. Rhetorical questions that don't expect a reply are also forbidden — rephrase as a statement.\n" +
    "\nMutation tools (update_transaction, split_transaction):\n" +
    "- Run them ONLY when the user explicitly asks to change or split a transaction. Never speculate.\n" +
    "- Always identify the row via transaction_id from a prior search_transactions call. If you don't have one, run search_transactions first.\n" +
    "- If the search returns more than one plausible match, you MUST call the ask_user tool to disambiguate before mutating. Do NOT answer with a text question listing the options — that orphans the user's reply. Use the ask_user tool so the conversation resumes properly.\n" +
    "- After a successful mutation, briefly confirm what changed in plain text (e.g. 'Updated: category Food → Transfer'). Do not re-run search.\n" +
    "- For split_transaction: if the user has multiple groups and the user didn't specify one, call get_groups first; if still ambiguous, call ask_user.\n"
  );
}

// ─── Tool-calling Loop ───────────────────────────────────────────────

var ASK_MAX_ITERATIONS = 3;
// Hard cap on how deep an ask_user reply-thread can go before we force the
// user to start a fresh /ask. Protects against runaway conversations and
// keeps the cached message blob bounded.
var ASK_MAX_TURNS = 5;
// CacheService TTL for a suspended /ask convo. Telegram force_reply has no
// expiry but the user practically replies within a few minutes; 10 minutes
// is a generous bound that fits well under the 6h CacheService cap.
var ASK_CONVO_TTL_SEC = 600;

// Run the LLM tool-calling loop for a /ask question.
//
// `onProgress` (optional): invoked before each LLM iteration. Used by the
// caller to re-emit a Telegram "typing..." chat action, which auto-expires
// after ~5s while iterations can take 2-5s each. No-op default keeps the
// function caller-agnostic and unit-testable.
//
// `opts` (optional):
//   - `chatId`: the personal tenant chat id. Required for mutation tools
//     (update_transaction, split_transaction, get_groups); ignored by the
//     pure-read tools.
//   - `messages`: an existing OpenAI messages array to resume from. When
//     supplied, `question` is ignored and the loop continues from the prior
//     conversation. The caller is responsible for appending the user's
//     reply as the `tool` message answering the suspended `ask_user` call
//     before invoking this.
//   - `turn`: 1-based conversation turn (1 = fresh /ask, 2+ = nth resume).
//     If > ASK_MAX_TURNS the loop refuses to run and returns an error.
//
// Return shape (always an object):
//   { kind: "final",   text }                                — answer ready
//   { kind: "suspend", text, messages, askCallId, turn }     — needs user reply
//   { kind: "error",   text }                                — unrecoverable
//
// Transactions are loaded lazily — the first tool call triggers the sheet
// read, then it's reused for the rest of the loop. If the LLM happens to
// answer in iteration 1 with no tool call (rare, e.g. clarification), we
// skip the read entirely and save 0.5-3s.
function runAskLoop(question, onProgress, opts) {
  onProgress = onProgress || function () {};
  opts = opts || {};
  var turn = opts.turn || 1;
  // ctx is passed to executeAskTool so mutation tools can resolve the
  // current personal tenant / group context. Pure-read tools ignore it.
  var ctx = { chatId: opts.chatId || null };

  if (turn > ASK_MAX_TURNS) {
    return {
      kind: "error",
      text: "This /ask conversation has too many follow-ups. Start over with /ask <full question>."
    };
  }

  // Clone opts.messages so we don't surprise-mutate the caller's array as
  // we append assistant / tool turns through the loop. The result still
  // surfaces the appended history via `result.messages` for follow-up
  // stashing.
  var messages = opts.messages
    ? opts.messages.slice()
    : [
        { role: "system", content: getAskSystemPrompt() },
        { role: "user", content: question }
      ];

  var _txns = null;
  function getTxns() {
    if (_txns === null) _txns = getAllTransactions();
    return _txns;
  }

  for (var i = 0; i < ASK_MAX_ITERATIONS; i++) {
    onProgress();
    var response = callAIWithTools(messages, ASK_TOOLS);

    if (!response) {
      return { kind: "error", text: "Sorry, I couldn't process that. Try /stats for preset analytics." };
    }

    var choice = response.choices[0];

    // Final assistant text. We append the turn to `messages` so the result's
    // history is complete for follow-up stashing in BotHandlers (the
    // Follow-up button uses this to resume the convo). The system-prompt
    // rule forbids the LLM from asking a question here; if it slips through,
    // the Follow-up button on the final response still lets the user reply.
    if (choice.finish_reason === "stop" && choice.message.content) {
      var text = choice.message.content;
      messages.push({ role: "assistant", content: text });
      return { kind: "final", text: text, messages: messages, turn: turn };
    }

    // If the model wants to call tools
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      // Add the assistant message with tool_calls to conversation
      messages.push(choice.message);

      // Execute every non-ask_user tool inline. If ask_user is present we
      // suspend AFTER siblings are resolved so resume only needs to supply
      // the user's reply. The OpenAI contract requires every tool_call to
      // get a matching tool message before the next assistant turn — we
      // satisfy that for non-ask tools here, and for the ask_user call on
      // resume.
      var askUserCall = null;
      for (var j = 0; j < choice.message.tool_calls.length; j++) {
        var toolCall = choice.message.tool_calls[j];
        if (toolCall.function.name === "ask_user") {
          askUserCall = toolCall;
          continue;
        }
        var args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (_) {
          args = {};
        }
        var result = executeAskTool(toolCall.function.name, args, getTxns(), ctx);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      if (askUserCall) {
        var q = "";
        try {
          q = (JSON.parse(askUserCall.function.arguments) || {}).question || "";
        } catch (_) {}
        return {
          kind: "suspend",
          text: q || "Could you share a bit more detail?",
          messages: messages,
          askCallId: askUserCall.id,
          turn: turn
        };
      }
    } else {
      // No tool calls and no content — unexpected
      return {
        kind: "final",
        text: choice.message.content || "I couldn't find an answer to that. Try being more specific.",
        messages: messages,
        turn: turn
      };
    }
  }

  return {
    kind: "error",
    text: "I took too many steps trying to answer that. Try a simpler question or use /stats."
  };
}

// ─── Conversation State Cache ────────────────────────────────────────
// Pattern 3: when the LLM calls ask_user we suspend the loop and stash the
// full message history in CacheService, keyed by the bot's outgoing
// message_id. When the user taps Reply on that message and sends text,
// the bot looks up the stash by reply_to_message.message_id and resumes.
// Single-use: the load path clears the entry so a double-tap can't double
// charge quota or burn Azure tokens.

function _askConvoKey(chatId, messageId) {
  return "askc:" + chatId + ":" + messageId;
}

function saveAskConvo(chatId, messageId, messages, askCallId, turn) {
  CacheService.getScriptCache().put(
    _askConvoKey(chatId, messageId),
    JSON.stringify({ messages: messages, askCallId: askCallId, turn: turn }),
    ASK_CONVO_TTL_SEC
  );
}

function loadAskConvo(chatId, messageId) {
  var raw = CacheService.getScriptCache().get(_askConvoKey(chatId, messageId));
  return raw ? JSON.parse(raw) : null;
}

function clearAskConvo(chatId, messageId) {
  CacheService.getScriptCache().remove(_askConvoKey(chatId, messageId));
}
