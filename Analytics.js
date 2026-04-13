// Read all transactions from the sheet as structured objects
function getAllTransactions() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  data.shift(); // remove header

  return data.map(function (row) {
    var rawDate = row[1] || row[0]; // Transaction Date preferred, fall back to Email Date
    var dateObj = rawDate instanceof Date ? rawDate : new Date(rawDate);
    return {
      date: dateObj,
      merchant: (row[2] || "").toString(),
      amount: parseFloat(row[3]) || 0,
      category: (row[4] || "Uncategorized").toString(),
      type: (row[5] || "").toString(),
      user: (row[6] || "").toString(),
      split: (row[7] || "").toString(),
      currency: (row[9] || "INR").toString()
    };
  });
}

// Filter transactions to a specific year/month
function filterByMonth(transactions, year, month) {
  return transactions.filter(function (t) {
    return t.date.getFullYear() === year && t.date.getMonth() === month;
  });
}

// ─── Monthly Analytics ───────────────────────────────────────────────

function getMonthlyAnalytics(year, month, numMonths) {
  numMonths = numMonths || 1;
  var all = getAllTransactions();

  var txns = [];
  for (var i = numMonths - 1; i >= 0; i--) {
    var d = new Date(year, month - i, 1);
    txns = txns.concat(filterByMonth(all, d.getFullYear(), d.getMonth()));
  }

  if (txns.length === 0) return null;

  var debits = txns.filter(function (t) {
    return t.type === "Debit";
  });

  // Totals per currency
  var spentByCurrency = {};
  debits.forEach(function (t) {
    spentByCurrency[t.currency] = (spentByCurrency[t.currency] || 0) + t.amount;
  });

  // Category breakdown per currency
  var categorySpend = {};
  debits.forEach(function (t) {
    var key = t.category + "|||" + t.currency;
    categorySpend[key] = (categorySpend[key] || 0) + t.amount;
  });

  // Top merchants by spend (within primary currency INR, fallback to all)
  var merchantSpend = {};
  debits.forEach(function (t) {
    var key = t.merchant + "|||" + t.currency;
    merchantSpend[key] = (merchantSpend[key] || 0) + t.amount;
  });
  var sortedMerchants = Object.keys(merchantSpend)
    .sort(function (a, b) {
      return merchantSpend[b] - merchantSpend[a];
    })
    .slice(0, 5);

  // Split ratio
  var splitCount = debits.filter(function (t) {
    return t.split === SPLIT_STATUS.SPLIT;
  }).length;
  var personalCount = debits.length - splitCount;

  // Per-user spend
  var userSpend = {};
  debits.forEach(function (t) {
    if (!userSpend[t.user]) userSpend[t.user] = {};
    userSpend[t.user][t.currency] = (userSpend[t.user][t.currency] || 0) + t.amount;
  });

  return {
    totalTransactions: txns.length,
    debitCount: debits.length,
    spentByCurrency: spentByCurrency,
    categorySpend: categorySpend,
    topMerchants: sortedMerchants.map(function (key) {
      var parts = key.split("|||");
      return { merchant: parts[0], currency: parts[1], amount: merchantSpend[key] };
    }),
    splitCount: splitCount,
    personalCount: personalCount,
    userSpend: userSpend
  };
}

function formatMonthlyMessage(year, month, data, numMonths) {
  numMonths = numMonths || 1;
  var tz = Session.getScriptTimeZone();
  var endDate = new Date(year, month, 1);
  var label;
  if (numMonths === 1) {
    label = Utilities.formatDate(endDate, tz, "MMMM yyyy");
  } else {
    var startDate = new Date(year, month - numMonths + 1, 1);
    label = Utilities.formatDate(startDate, tz, "MMM yyyy") + " — " + Utilities.formatDate(endDate, tz, "MMM yyyy");
  }

  var msg = "📊 *Report — " + label + "*\n\n";
  msg += "📈 *Transactions:* " + data.totalTransactions + " (" + data.debitCount + " debits)\n\n";

  // Total spend — INR first
  msg += "💰 *Total Spent:*\n";
  var currencies = Object.keys(data.spentByCurrency);
  var inrFirst = currencies.sort(function (a, b) {
    return a === "INR" ? -1 : b === "INR" ? 1 : a.localeCompare(b);
  });
  inrFirst.forEach(function (cur) {
    msg += "  " + cur + " " + formatAmount(data.spentByCurrency[cur]) + "\n";
  });

  // Category breakdown
  msg += "\n📂 *By Category:*\n";
  var sortedCats = Object.keys(data.categorySpend).sort(function (a, b) {
    return data.categorySpend[b] - data.categorySpend[a];
  });
  sortedCats.forEach(function (catKey) {
    var parts = catKey.split("|||");
    var cat = parts[0];
    var cur = parts[1];
    var amount = data.categorySpend[catKey];
    var pct = ((amount / (data.spentByCurrency[cur] || 1)) * 100).toFixed(1);
    var emoji = CATEGORY_EMOJIS[cat] || "•";
    msg += emoji + " " + escapeMarkdown(cat) + ": " + cur + " " + formatAmount(amount) + " (" + pct + "%)\n";
  });

  // Top merchants
  if (data.topMerchants.length > 0) {
    msg += "\n🏪 *Top Merchants:*\n";
    data.topMerchants.forEach(function (m, i) {
      msg += i + 1 + ". " + escapeMarkdown(m.merchant) + " — " + m.currency + " " + formatAmount(m.amount) + "\n";
    });
  }

  // Split ratio
  msg += "\n✂️ *Split:* " + data.splitCount + " | *Personal:* " + data.personalCount + "\n";

  // Per-user spend
  var users = Object.keys(data.userSpend);
  if (users.length > 1) {
    msg += "\n👥 *Per User:*\n";
    users.forEach(function (user) {
      var perCur = data.userSpend[user];
      var parts = Object.keys(perCur).map(function (cur) {
        return cur + " " + formatAmount(perCur[cur]);
      });
      msg += "• " + escapeMarkdown(user) + ": " + parts.join(", ") + "\n";
    });
  }

  return msg;
}

// ─── Trends Analytics ────────────────────────────────────────────────

function getTrendsAnalytics(numMonths) {
  numMonths = numMonths || 6;
  var all = getAllTransactions();
  var now = new Date();

  var months = [];
  for (var i = numMonths - 1; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var year = d.getFullYear();
    var month = d.getMonth();
    var txns = filterByMonth(all, year, month);
    var debits = txns.filter(function (t) {
      return t.type === "Debit";
    });
    var credits = txns.filter(function (t) {
      return t.type === "Credit";
    });

    var debitByCurrency = {};
    var creditByCurrency = {};
    var categorySpend = {};
    debits.forEach(function (t) {
      debitByCurrency[t.currency] = (debitByCurrency[t.currency] || 0) + t.amount;
      categorySpend[t.category] = (categorySpend[t.category] || 0) + t.amount;
    });
    credits.forEach(function (t) {
      creditByCurrency[t.currency] = (creditByCurrency[t.currency] || 0) + t.amount;
    });

    months.push({
      year: year,
      month: month,
      txnCount: txns.length,
      debitByCurrency: debitByCurrency,
      creditByCurrency: creditByCurrency,
      categorySpend: categorySpend
    });
  }

  return months;
}

function formatTrendsMessage(months) {
  var tz = Session.getScriptTimeZone();
  var msg = "📉 *Spending Trends*\n\n";

  // Compact INR debits with bar chart
  msg += "💸 *Debits (INR):*\n";
  months.forEach(function (m) {
    var d = new Date(m.year, m.month, 1);
    var label = Utilities.formatDate(d, tz, "MMM yy");
    var inr = m.debitByCurrency["INR"] || 0;
    var bar = makeBar(inr, months, "debit");
    msg += "`" + label + "` " + bar + " ₹" + formatAmount(inr) + "\n";
  });

  // Non-INR debits — only months that have them, compact
  var hasOtherDebits = months.some(function (m) {
    return Object.keys(m.debitByCurrency).some(function (c) {
      return c !== "INR";
    });
  });
  if (hasOtherDebits) {
    msg += "\n🌍 *Other Currency Debits:*\n";
    months.forEach(function (m) {
      var others = Object.keys(m.debitByCurrency).filter(function (c) {
        return c !== "INR" && m.debitByCurrency[c] > 0;
      });
      if (others.length > 0) {
        var d = new Date(m.year, m.month, 1);
        var label = Utilities.formatDate(d, tz, "MMM yy");
        var parts = others.map(function (c) {
          return c + " " + formatAmount(m.debitByCurrency[c]);
        });
        msg += "`" + label + "` " + parts.join(", ") + "\n";
      }
    });
  }

  // Credits — separate section
  var hasCredits = months.some(function (m) {
    return Object.keys(m.creditByCurrency).length > 0;
  });
  if (hasCredits) {
    msg += "\n💰 *Credits:*\n";
    months.forEach(function (m) {
      var curs = Object.keys(m.creditByCurrency);
      if (curs.length > 0) {
        var d = new Date(m.year, m.month, 1);
        var label = Utilities.formatDate(d, tz, "MMM yy");
        var parts = curs.map(function (c) {
          return c + " " + formatAmount(m.creditByCurrency[c]);
        });
        msg += "`" + label + "` " + parts.join(", ") + "\n";
      }
    });
  }

  // Month-over-month delta (debits only)
  if (months.length >= 2) {
    var curr = months[months.length - 1];
    var prev = months[months.length - 2];
    var currTotal = curr.debitByCurrency["INR"] || 0;
    var prevTotal = prev.debitByCurrency["INR"] || 0;

    if (prevTotal > 0) {
      var delta = currTotal - prevTotal;
      var pct = ((delta / prevTotal) * 100).toFixed(1);
      var arrow = delta >= 0 ? "📈 +" : "📉 ";
      msg +=
        "\n*vs Last Month:* " +
        arrow +
        "₹" +
        formatAmount(Math.abs(delta)) +
        " (" +
        (delta >= 0 ? "+" : "") +
        pct +
        "%)\n";
    }

    // Top 3 category movers
    var allCats = {};
    Object.keys(curr.categorySpend || {}).forEach(function (c) {
      allCats[c] = true;
    });
    Object.keys(prev.categorySpend || {}).forEach(function (c) {
      allCats[c] = true;
    });

    var deltas = Object.keys(allCats)
      .map(function (cat) {
        var c = (curr.categorySpend || {})[cat] || 0;
        var p = (prev.categorySpend || {})[cat] || 0;
        return { category: cat, delta: c - p };
      })
      .filter(function (d) {
        return d.delta !== 0;
      })
      .sort(function (a, b) {
        return Math.abs(b.delta) - Math.abs(a.delta);
      })
      .slice(0, 3);

    if (deltas.length > 0) {
      msg += "\n🔄 *Biggest Changes:*\n";
      deltas.forEach(function (d) {
        var emoji = CATEGORY_EMOJIS[d.category] || "•";
        var arrow = d.delta > 0 ? "↑" : "↓";
        msg += emoji + " " + escapeMarkdown(d.category) + " " + arrow + " ₹" + formatAmount(Math.abs(d.delta)) + "\n";
      });
    }
  }

  return msg;
}

// ─── Who Owes ────────────────────────────────────────────────────────

function getWhoOwesAnalytics(year, month) {
  var all = getAllTransactions();
  var txns;
  if (year !== undefined && month !== undefined) {
    txns = filterByMonth(all, year, month);
  } else {
    // Default: current month
    var now = new Date();
    txns = filterByMonth(all, now.getFullYear(), now.getMonth());
  }

  var splitTxns = txns.filter(function (t) {
    return t.type === "Debit" && t.split === SPLIT_STATUS.SPLIT;
  });

  if (splitTxns.length === 0) return null;

  // Each user's total split spend (they paid this much for shared expenses)
  var userPaid = {};
  splitTxns.forEach(function (t) {
    if (!userPaid[t.user]) userPaid[t.user] = {};
    userPaid[t.user][t.currency] = (userPaid[t.user][t.currency] || 0) + t.amount;
  });

  var users = Object.keys(userPaid);
  // Collect all currencies involved
  var allCurrencies = {};
  users.forEach(function (u) {
    Object.keys(userPaid[u]).forEach(function (c) {
      allCurrencies[c] = true;
    });
  });

  // Per currency: each person's fair share = total / num_users
  // Settlement: who paid more than fair share is owed money
  var settlements = {};
  Object.keys(allCurrencies).forEach(function (cur) {
    var total = 0;
    users.forEach(function (u) {
      total += (userPaid[u] || {})[cur] || 0;
    });
    var fairShare = total / users.length;

    var balances = {};
    users.forEach(function (u) {
      var paid = (userPaid[u] || {})[cur] || 0;
      balances[u] = paid - fairShare; // positive = overpaid (is owed), negative = underpaid (owes)
    });

    settlements[cur] = { total: total, fairShare: fairShare, balances: balances };
  });

  return {
    splitCount: splitTxns.length,
    userPaid: userPaid,
    settlements: settlements,
    users: users
  };
}

function formatWhoOwesMessage(year, month, data) {
  var tz = Session.getScriptTimeZone();
  var monthDate = new Date(year, month, 1);
  var monthName = Utilities.formatDate(monthDate, tz, "MMMM yyyy");

  var msg = "💰 *Who Owes — " + monthName + "*\n\n";
  msg += "✂️ *Split transactions:* " + data.splitCount + "\n\n";

  // Per-user paid
  msg += "💳 *Each Person Paid:*\n";
  data.users.forEach(function (user) {
    var parts = Object.keys(data.userPaid[user]).map(function (cur) {
      return cur + " " + formatAmount(data.userPaid[user][cur]);
    });
    msg += "• " + escapeMarkdown(user) + ": " + parts.join(", ") + "\n";
  });

  // Settlement
  msg += "\n⚖️ *Settlement:*\n";
  Object.keys(data.settlements).forEach(function (cur) {
    var s = data.settlements[cur];
    msg +=
      "\n*" + cur + "* (total: " + formatAmount(s.total) + ", fair share: " + formatAmount(s.fairShare) + "/person)\n";

    var overpaid = [];
    var underpaid = [];
    data.users.forEach(function (u) {
      var bal = s.balances[u];
      if (bal > 0.01) overpaid.push({ user: u, amount: bal });
      else if (bal < -0.01) underpaid.push({ user: u, amount: Math.abs(bal) });
    });

    // Simple 2-person settlement
    if (overpaid.length > 0 && underpaid.length > 0) {
      underpaid.forEach(function (debtor) {
        overpaid.forEach(function (creditor) {
          var amt = Math.min(debtor.amount, creditor.amount);
          if (amt > 0.01) {
            msg +=
              "➡️ *" +
              escapeMarkdown(debtor.user) +
              "* owes *" +
              escapeMarkdown(creditor.user) +
              "* " +
              cur +
              " " +
              formatAmount(amt) +
              "\n";
          }
        });
      });
    } else {
      msg += "✅ All settled!\n";
    }
  });

  return msg;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatAmount(num) {
  return num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function makeBar(value, months, type) {
  var max = 0;
  months.forEach(function (m) {
    var bucket = type === "debit" ? m.debitByCurrency : m.creditByCurrency;
    var inr = (bucket || {})["INR"] || 0;
    if (inr > max) max = inr;
  });
  if (max === 0) return "";
  var len = Math.round((value / max) * 8);
  var bar = "";
  for (var i = 0; i < len; i++) bar += "▓";
  for (var j = len; j < 8; j++) bar += "░";
  return bar;
}
