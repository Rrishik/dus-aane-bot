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

  var spentByCurrency = sumByCurrency(debits);

  // Category breakdown (uses ||| separator for backward compat with formatter)
  var categorySpend = {};
  debits.forEach(function (t) {
    var key = t.category + "|||" + t.currency;
    categorySpend[key] = (categorySpend[key] || 0) + t.amount;
  });

  var topMerchants = aggregateByField(debits, "merchant")
    .slice(0, 5)
    .map(function (m) {
      return { merchant: m.name, currency: m.currency, amount: m.amount };
    });

  var splitCount = debits.filter(function (t) {
    return t.split === SPLIT_STATUS.SPLIT;
  }).length;

  return {
    totalTransactions: txns.length,
    debitCount: debits.length,
    spentByCurrency: spentByCurrency,
    categorySpend: categorySpend,
    topMerchants: topMerchants,
    splitCount: splitCount,
    personalCount: debits.length - splitCount,
    userSpend: aggregateByUser(debits)
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
    var now = new Date();
    txns = filterByMonth(all, now.getFullYear(), now.getMonth());
  }

  var debits = txns.filter(function (t) {
    return t.type === "Debit";
  });
  var result = calcSplitSettlement(debits);
  if (result.splitCount === 0) return null;
  return result;
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

// ─── Shared Aggregation Helpers ──────────────────────────────────────

// Filter transactions by date range (inclusive)
function filterByDateRange(transactions, startDate, endDate) {
  var start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  var end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  return transactions.filter(function (t) {
    return t.date >= start && t.date <= end;
  });
}

// Sum amounts by currency from a list of transactions
function sumByCurrency(transactions) {
  var result = {};
  transactions.forEach(function (t) {
    result[t.currency] = (result[t.currency] || 0) + t.amount;
  });
  return result;
}

// Group transactions by a key field + currency, returning {amount, count} per group
function aggregateByField(transactions, field) {
  var groups = {};
  transactions.forEach(function (t) {
    var key = t[field] + "|" + t.currency;
    if (!groups[key]) groups[key] = { name: t[field], currency: t.currency, amount: 0, count: 0 };
    groups[key].amount += t.amount;
    groups[key].count++;
  });
  return Object.keys(groups)
    .map(function (k) {
      return groups[k];
    })
    .sort(function (a, b) {
      return b.amount - a.amount;
    });
}

// Per-user spend breakdown
function aggregateByUser(transactions) {
  var users = {};
  transactions.forEach(function (t) {
    if (!users[t.user]) users[t.user] = {};
    users[t.user][t.currency] = (users[t.user][t.currency] || 0) + t.amount;
  });
  return users;
}

// Calculate split settlements between users
function calcSplitSettlement(debits) {
  var splitTxns = debits.filter(function (t) {
    return t.split === SPLIT_STATUS.SPLIT;
  });
  var personalTxns = debits.filter(function (t) {
    return t.split !== SPLIT_STATUS.SPLIT;
  });

  var splitTotal = sumByCurrency(splitTxns);
  var personalTotal = sumByCurrency(personalTxns);
  var userPaid = aggregateByUser(splitTxns);
  var users = Object.keys(userPaid);

  // Per currency: fair share = total / num_users
  var settlements = {};
  Object.keys(splitTotal).forEach(function (cur) {
    var total = splitTotal[cur];
    var fairShare = total / Math.max(users.length, 1);
    var balances = {};
    users.forEach(function (u) {
      var paid = (userPaid[u] || {})[cur] || 0;
      balances[u] = paid - fairShare;
    });
    settlements[cur] = { total: total, fairShare: fairShare, balances: balances };
  });

  return {
    splitCount: splitTxns.length,
    personalCount: personalTxns.length,
    splitTotal: splitTotal,
    personalTotal: personalTotal,
    userPaid: userPaid,
    users: users,
    settlements: settlements
  };
}
