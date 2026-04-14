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
      name: "get_split_summary",
      description:
        "Get split vs personal expense summary for a date range. Shows totals, per-user paid amounts, and who owes whom.",
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
  }
];

// ─── Tool Executor ───────────────────────────────────────────────────

function executeAskTool(toolName, args) {
  var all = getAllTransactions();
  var filtered = all;

  // Apply date filter if present
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

    case "get_split_summary":
      var settlement = calcSplitSettlement(debits);
      return {
        split_count: settlement.splitCount,
        personal_count: settlement.personalCount,
        split_total_by_currency: settlement.splitTotal,
        personal_total_by_currency: settlement.personalTotal,
        user_paid: settlement.userPaid,
        settlements: settlement.settlements
      };

    case "search_transactions":
      return execSearchTransactions(filtered, args);

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
        date: Utilities.formatDate(t.date, tz, "yyyy-MM-dd"),
        merchant: t.merchant,
        amount: t.amount,
        currency: t.currency,
        category: t.category,
        type: t.type,
        user: t.user,
        split: t.split
      };
    })
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
    "- Format currency amounts with the currency code (e.g. INR 1,234.56). Show INR prominently; other currencies only if present\n" +
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
    "- Use short/common merchant name for search — the data may have suffixes like _mws_merch\n"
  );
}

// ─── Tool-calling Loop ───────────────────────────────────────────────

var ASK_MAX_ITERATIONS = 3;

function runAskLoop(question) {
  var messages = [
    { role: "system", content: getAskSystemPrompt() },
    { role: "user", content: question }
  ];

  for (var i = 0; i < ASK_MAX_ITERATIONS; i++) {
    var response = callAIWithTools(messages, ASK_TOOLS);

    if (!response) {
      return "Sorry, I couldn't process that. Try /stats for preset analytics.";
    }

    var choice = response.choices[0];

    // If the model returned a text answer, we're done
    if (choice.finish_reason === "stop" && choice.message.content) {
      return choice.message.content;
    }

    // If the model wants to call tools
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      // Add the assistant message with tool_calls to conversation
      messages.push(choice.message);

      // Execute each tool call and add results
      choice.message.tool_calls.forEach(function (toolCall) {
        var args = JSON.parse(toolCall.function.arguments);
        var result = executeAskTool(toolCall.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      });
    } else {
      // No tool calls and no content — unexpected
      return choice.message.content || "I couldn't find an answer to that. Try being more specific.";
    }
  }

  return "I took too many steps trying to answer that. Try a simpler question or use /stats.";
}
