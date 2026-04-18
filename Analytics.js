// Read all transactions from the sheet as structured objects
function getAllTransactions() {
  var sheet = getSpreadsheet().getSheets()[0];
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

  // Previous period category data for deltas
  var prevCategorySpend = {};
  if (numMonths === 1) {
    var prevMonth = new Date(year, month - 1, 1);
    var prevTxns = filterByMonth(all, prevMonth.getFullYear(), prevMonth.getMonth());
    var prevDebits = prevTxns.filter(function (t) {
      return t.type === "Debit";
    });
    prevDebits.forEach(function (t) {
      var key = t.category + "|||" + t.currency;
      prevCategorySpend[key] = (prevCategorySpend[key] || 0) + t.amount;
    });
  }

  // Top 5 transactions by amount
  var topTransactions = debits
    .slice()
    .sort(function (a, b) {
      return b.amount - a.amount;
    })
    .slice(0, 5)
    .map(function (t) {
      return { merchant: t.merchant, amount: t.amount, currency: t.currency, date: t.date };
    });

  // Split settlement data
  var settlement = calcSplitSettlement(debits);

  return {
    totalTransactions: txns.length,
    debitCount: debits.length,
    spentByCurrency: spentByCurrency,
    categorySpend: categorySpend,
    prevCategorySpend: prevCategorySpend,
    topTransactions: topTransactions,
    settlement: settlement,
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

  // Header with total
  var inrTotal = data.spentByCurrency["INR"] || 0;
  var msg = "📊 *" + label + "* — ₹" + formatAmount(inrTotal) + "\n\n";

  // Other currencies if present
  var otherCurs = Object.keys(data.spentByCurrency).filter(function (c) {
    return c !== "INR" && data.spentByCurrency[c] > 0;
  });
  if (otherCurs.length > 0) {
    var otherParts = otherCurs.map(function (c) {
      return c + " " + formatAmount(data.spentByCurrency[c]);
    });
    msg += "🌍 " + otherParts.join(" · ") + "\n\n";
  }

  // Category breakdown — top 5 with deltas, rest collapsed
  var sortedCats = Object.keys(data.categorySpend).sort(function (a, b) {
    return data.categorySpend[b] - data.categorySpend[a];
  });

  var maxCatNameLen = 0;
  sortedCats.slice(0, 5).forEach(function (catKey) {
    var catName = catKey.split("|||")[0];
    if (catName.length > maxCatNameLen) maxCatNameLen = catName.length;
  });

  var topCats = sortedCats.slice(0, 5);
  var restAmount = 0;
  var restCount = 0;
  sortedCats.slice(5).forEach(function (catKey) {
    restAmount += data.categorySpend[catKey];
    restCount++;
  });

  topCats.forEach(function (catKey) {
    var parts = catKey.split("|||");
    var cat = parts[0];
    var cur = parts[1];
    var amount = data.categorySpend[catKey];
    var emoji = CATEGORY_EMOJIS[cat] || "•";
    var padded = cat + " ".repeat(Math.max(0, maxCatNameLen - cat.length));

    // Delta vs previous month
    var delta = "";
    if (data.prevCategorySpend && numMonths === 1) {
      var prevAmt = data.prevCategorySpend[catKey] || 0;
      var diff = amount - prevAmt;
      if (diff > 0) delta = "  ↑" + formatAmount(diff);
      else if (diff < 0) delta = "  ↓" + formatAmount(Math.abs(diff));
    }

    msg += emoji + " `" + padded + "  ₹" + formatAmount(amount) + "`" + delta + "\n";
  });

  if (restCount > 0) {
    msg +=
      "   `\\+" +
      restCount +
      " more" +
      " ".repeat(Math.max(0, maxCatNameLen - 6)) +
      "  ₹" +
      formatAmount(restAmount) +
      "`\n";
  }

  // Top 5 transactions by amount
  if (data.topTransactions && data.topTransactions.length > 0) {
    msg += "\n💳 *Top Transactions:*\n";
    data.topTransactions.forEach(function (t, i) {
      var dateStr = t.date instanceof Date ? Utilities.formatDate(t.date, tz, "MMM dd") : t.date;
      msg +=
        i +
        1 +
        "\\. " +
        escapeMarkdown(t.merchant || "Unknown") +
        "  ₹" +
        formatAmount(t.amount) +
        "  " +
        dateStr +
        "\n";
    });
  }

  // Per-user total spend
  var users = Object.keys(data.userSpend);
  if (users.length > 0) {
    msg += "\n";
    users.forEach(function (user) {
      var perCur = data.userSpend[user];
      var inr = perCur["INR"] || 0;
      msg += "👤 " + escapeMarkdown(user) + "  ₹" + formatAmount(inr) + "\n";
    });
  }

  // Split + Partner settlement
  var s = data.settlement;
  var sharedCount = s ? (s.splitCount || 0) + (s.partnerCount || 0) : 0;
  if (s && sharedCount > 0) {
    var splitInr = (s.splitTotal && s.splitTotal["INR"]) || 0;
    var partnerInr = (s.partnerTotal && s.partnerTotal["INR"]) || 0;
    msg += "\n✂️ *Shared Total:* ₹" + formatAmount(splitInr + partnerInr);
    if (partnerInr > 0) {
      msg += "  _(split ₹" + formatAmount(splitInr) + " + partner ₹" + formatAmount(partnerInr) + ")_";
    }
    msg += "\n";
    s.users.forEach(function (u) {
      var paid = (s.userPaid[u] || {})["INR"] || 0;
      msg += "   " + escapeMarkdown(u) + " paid  ₹" + formatAmount(paid) + "\n";
    });

    // Settlement lines
    var inrSettlement = s.settlements["INR"];
    if (inrSettlement) {
      var overpaid = [];
      var underpaid = [];
      s.users.forEach(function (u) {
        var bal = inrSettlement.balances[u];
        if (bal > 0.01) overpaid.push({ user: u, amount: bal });
        else if (bal < -0.01) underpaid.push({ user: u, amount: Math.abs(bal) });
      });
      underpaid.forEach(function (debtor) {
        overpaid.forEach(function (creditor) {
          var amt = Math.min(debtor.amount, creditor.amount);
          if (amt > 0.01) {
            msg +=
              "   ➡️ " +
              escapeMarkdown(debtor.user) +
              " owes " +
              escapeMarkdown(creditor.user) +
              " ₹" +
              formatAmount(amt) +
              "\n";
          }
        });
      });
    }
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
  if (result.splitCount === 0 && result.partnerCount === 0) return null;
  return result;
}

function formatWhoOwesMessage(year, month, data) {
  var tz = Session.getScriptTimeZone();
  var monthDate = new Date(year, month, 1);
  var monthName = Utilities.formatDate(monthDate, tz, "MMMM yyyy");

  var msg = "💰 *Who Owes — " + monthName + "*\n\n";
  msg += "✂️ *Split:* " + data.splitCount + "   👤 *Partner:* " + data.partnerCount + "\n\n";

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
    var breakdown = "split " + formatAmount(s.splitTotal);
    if (s.partnerTotal > 0) breakdown += ", partner " + formatAmount(s.partnerTotal);
    msg += "\n*" + cur + "* (total: " + formatAmount(s.total) + " — " + breakdown + ")\n";

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
// Split = 50/50 shared; Partner = payer paid 100% on behalf of other user(s)
function calcSplitSettlement(debits) {
  var splitTxns = debits.filter(function (t) {
    return t.split === SPLIT_STATUS.SPLIT;
  });
  var partnerTxns = debits.filter(function (t) {
    return t.split === SPLIT_STATUS.PARTNER;
  });
  var personalTxns = debits.filter(function (t) {
    return t.split !== SPLIT_STATUS.SPLIT && t.split !== SPLIT_STATUS.PARTNER;
  });

  var splitTotal = sumByCurrency(splitTxns);
  var partnerTotal = sumByCurrency(partnerTxns);
  var personalTotal = sumByCurrency(personalTxns);
  var userPaidSplit = aggregateByUser(splitTxns);
  var userPaidPartner = aggregateByUser(partnerTxns);

  // All known users = union of payers in split/partner txns + anyone else seen in debits
  // (needed so Partner txns can identify "the other user" for settlement)
  var userSet = {};
  debits.forEach(function (t) {
    if (t.user) userSet[t.user] = true;
  });
  var users = Object.keys(userSet);

  // All currencies seen in shared txns
  var currencySet = {};
  Object.keys(splitTotal).forEach(function (c) {
    currencySet[c] = true;
  });
  Object.keys(partnerTotal).forEach(function (c) {
    currencySet[c] = true;
  });

  var settlements = {};
  Object.keys(currencySet).forEach(function (cur) {
    var balances = {};
    users.forEach(function (u) {
      balances[u] = 0;
    });

    // Split: each user's share = splitTotal / n_users, payer gets credited full amount
    var splitCur = splitTotal[cur] || 0;
    var fairShare = users.length > 0 ? splitCur / users.length : 0;
    users.forEach(function (u) {
      var paid = (userPaidSplit[u] || {})[cur] || 0;
      balances[u] += paid - fairShare;
    });

    // Partner: payer credited full amount; the other user(s) share the full cost equally
    partnerTxns.forEach(function (t) {
      if (t.currency !== cur) return;
      var others = users.filter(function (u) {
        return u !== t.user;
      });
      if (others.length === 0) return; // Can't settle without a counterparty
      var shareOther = t.amount / others.length;
      balances[t.user] += t.amount;
      others.forEach(function (u) {
        balances[u] -= shareOther;
      });
    });

    settlements[cur] = {
      total: splitCur + (partnerTotal[cur] || 0),
      splitTotal: splitCur,
      partnerTotal: partnerTotal[cur] || 0,
      fairShare: fairShare,
      balances: balances
    };
  });

  // Combined userPaid for display (split + partner)
  var userPaid = {};
  users.forEach(function (u) {
    userPaid[u] = {};
    var s = userPaidSplit[u] || {};
    var p = userPaidPartner[u] || {};
    Object.keys(s).forEach(function (c) {
      userPaid[u][c] = (userPaid[u][c] || 0) + s[c];
    });
    Object.keys(p).forEach(function (c) {
      userPaid[u][c] = (userPaid[u][c] || 0) + p[c];
    });
  });

  return {
    splitCount: splitTxns.length,
    partnerCount: partnerTxns.length,
    personalCount: personalTxns.length,
    splitTotal: splitTotal,
    partnerTotal: partnerTotal,
    personalTotal: personalTotal,
    userPaid: userPaid,
    userPaidSplit: userPaidSplit,
    userPaidPartner: userPaidPartner,
    users: users,
    settlements: settlements
  };
}
