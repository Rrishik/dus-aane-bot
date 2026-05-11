// Read all transactions as structured objects.
function getAllTransactions() {
  var sheet = getSpreadsheet().getSheets()[0];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  data.shift(); // remove header

  return data.map(function (row) {
    var rawDate = row[TRANSACTION_DATE_COLUMN - 1] || row[EMAIL_DATE_COLUMN - 1]; // Transaction Date preferred, fall back to Email Date
    var dateObj = rawDate instanceof Date ? rawDate : new Date(rawDate);
    return {
      date: dateObj,
      merchant: (row[MERCHANT_COLUMN - 1] || "").toString(),
      amount: parseFloat(row[AMOUNT_COLUMN - 1]) || 0,
      category: (row[CATEGORY_COLUMN - 1] || "Uncategorized").toString(),
      type: (row[TRANSACTION_TYPE_COLUMN - 1] || "").toString(),
      user: (row[USER_COLUMN - 1] || "").toString(),
      split: (row[SPLIT_COLUMN - 1] || "").toString(),
      currency: (row[CURRENCY_COLUMN - 1] || "INR").toString()
    };
  });
}

function filterByMonth(transactions, year, month) {
  return transactions.filter(function (t) {
    return t.date.getFullYear() === year && t.date.getMonth() === month;
  });
}

// ─── Weekly Analytics ────────────────────────────────────────────────

// Rolling 7-day window ending yesterday (relative to `today`). Day-of-week
// independent so the digest is always fresh regardless of which weekday the
// trigger fires on. Friday-morning trigger → covers prior Fri 00:00 - Thu 23:59.
function weekRangeFor(today) {
  var end = new Date(today);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);
  var start = new Date(end);
  start.setDate(end.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return { start: start, end: end };
}

function getWeeklyAnalytics(startDate, endDate) {
  var all = getAllTransactions();
  var txns = filterByDateRange(all, startDate, endDate);
  if (txns.length === 0) return null;

  var debits = txns.filter(function (t) {
    return t.type === "Debit";
  });

  var spentByCurrency = sumByCurrency(debits);

  var categorySpend = {};
  debits.forEach(function (t) {
    var key = t.category + "|||" + t.currency;
    categorySpend[key] = (categorySpend[key] || 0) + t.amount;
  });

  // Previous week for delta
  var prevEnd = new Date(startDate);
  prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1);
  var prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - 6);
  prevStart.setHours(0, 0, 0, 0);
  var prevTxns = filterByDateRange(all, prevStart, prevEnd);
  var prevDebits = prevTxns.filter(function (t) {
    return t.type === "Debit";
  });
  var prevSpentByCurrency = sumByCurrency(prevDebits);

  var topTransactions = debits
    .slice()
    .sort(function (a, b) {
      return b.amount - a.amount;
    })
    .slice(0, 5)
    .map(function (t) {
      return { merchant: t.merchant, amount: t.amount, currency: t.currency, date: t.date };
    });

  return {
    totalTransactions: txns.length,
    debitCount: debits.length,
    spentByCurrency: spentByCurrency,
    prevSpentByCurrency: prevSpentByCurrency,
    categorySpend: categorySpend,
    topTransactions: topTransactions
  };
}

function formatWeeklyMessage(range, data) {
  var tz = Session.getScriptTimeZone();
  var label = Utilities.formatDate(range.start, tz, "MMM d") + "–" + Utilities.formatDate(range.end, tz, "MMM d");

  var inrTotal = data.spentByCurrency["INR"] || 0;
  var prevInr = (data.prevSpentByCurrency && data.prevSpentByCurrency["INR"]) || 0;
  var msg = "📅 *Last Week* — " + label + "\n";
  msg += "� ₹" + formatAmount(inrTotal);
  if (prevInr > 0) {
    var diff = inrTotal - prevInr;
    var pct = Math.round((diff / prevInr) * 100);
    var arrow = diff >= 0 ? "↑" : "↓";
    msg += "  _(vs ₹" + formatAmount(prevInr) + ", " + arrow + Math.abs(pct) + "%)_";
  }
  msg += "\n";

  var otherCurs = Object.keys(data.spentByCurrency).filter(function (c) {
    return c !== "INR" && data.spentByCurrency[c] > 0;
  });
  if (otherCurs.length > 0) {
    var otherParts = otherCurs.map(function (c) {
      return currencySymbol(c) + formatAmount(data.spentByCurrency[c]);
    });
    msg += "🌍 " + otherParts.join(" · ") + "\n";
  }
  msg += "\n";

  // Top 5 categories with collapsed remainder
  var sortedCats = Object.keys(data.categorySpend).sort(function (a, b) {
    return data.categorySpend[b] - data.categorySpend[a];
  });
  var topCats = sortedCats.slice(0, 5);
  var maxCatNameLen = 0;
  topCats.forEach(function (catKey) {
    var name = catKey.split("|||")[0];
    if (name.length > maxCatNameLen) maxCatNameLen = name.length;
  });
  topCats.forEach(function (catKey) {
    var parts = catKey.split("|||");
    var cat = parts[0];
    var amount = data.categorySpend[catKey];
    var emoji = CATEGORY_EMOJIS[cat] || "•";
    var padded = cat + " ".repeat(Math.max(0, maxCatNameLen - cat.length));
    msg += emoji + " `" + padded + "  ₹" + formatAmount(amount) + "`\n";
  });
  if (sortedCats.length > 5) {
    var restAmount = 0;
    sortedCats.slice(5).forEach(function (catKey) {
      restAmount += data.categorySpend[catKey];
    });
    msg +=
      "   `\\+" +
      (sortedCats.length - 5) +
      " more" +
      " ".repeat(Math.max(0, maxCatNameLen - 6)) +
      "  ₹" +
      formatAmount(restAmount) +
      "`\n";
  }

  if (data.topTransactions && data.topTransactions.length > 0) {
    msg += "\n💳 *Top:*\n";
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

  // Each row is wrapped in a single backtick code span so Telegram renders it
  // monospaced — that's what keeps the date, bar, and amount columns visually
  // aligned across rows even when amount widths differ (₹500 vs ₹54321).
  // Outside a code span, Telegram collapses runs of spaces and uses a
  // proportional font, so columns drift.

  // INR debits with bar chart — right-align amounts to a common width so the
  // rightmost digit lines up across months.
  msg += "� *Debits (INR):*\n";
  var inrAmounts = months.map(function (m) {
    return formatAmount(m.debitByCurrency["INR"] || 0);
  });
  var maxInrWidth = inrAmounts.reduce(function (w, a) {
    return Math.max(w, a.length);
  }, 0);
  months.forEach(function (m, i) {
    var d = new Date(m.year, m.month, 1);
    var label = Utilities.formatDate(d, tz, "MMM yy");
    var inr = m.debitByCurrency["INR"] || 0;
    var bar = makeBar(inr, months, "debit");
    var amt = inrAmounts[i].padStart(maxInrWidth, " ");
    msg += "`" + label + "  " + bar + "  ₹" + amt + "`\n";
  });

  // Non-INR debits — only months that have them, compact. Multi-currency
  // composition varies per row so amounts are left-flowed inside the code span
  // rather than column-aligned.
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
          return currencySymbol(c) + formatAmount(m.debitByCurrency[c]);
        });
        msg += "`" + label + "  " + parts.join(", ") + "`\n";
      }
    });
  }

  // Credits — separate section, same code-span treatment.
  var hasCredits = months.some(function (m) {
    return Object.keys(m.creditByCurrency).length > 0;
  });
  if (hasCredits) {
    msg += "\n🟢 *Credits:*\n";
    months.forEach(function (m) {
      var curs = Object.keys(m.creditByCurrency);
      if (curs.length > 0) {
        var d = new Date(m.year, m.month, 1);
        var label = Utilities.formatDate(d, tz, "MMM yy");
        var parts = curs.map(function (c) {
          return currencySymbol(c) + formatAmount(m.creditByCurrency[c]);
        });
        msg += "`" + label + "  " + parts.join(", ") + "`\n";
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
        msg +=
          emoji +
          " " +
          escapeMarkdown(shortCategoryName(d.category)) +
          " " +
          arrow +
          " ₹" +
          formatAmount(Math.abs(d.delta)) +
          "\n";
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
      return currencySymbol(cur) + formatAmount(data.userPaid[user][cur]);
    });
    msg += "• " + escapeMarkdown(user) + ": " + parts.join(", ") + "\n";
  });

  // Settlement
  msg += "\n⚖️ *Settlement:*\n";
  Object.keys(data.settlements).forEach(function (cur) {
    var s = data.settlements[cur];
    var sym = currencySymbol(cur);
    var breakdown = "split " + sym + formatAmount(s.splitTotal);
    if (s.partnerTotal > 0) breakdown += ", partner " + sym + formatAmount(s.partnerTotal);
    msg += "\n*" + cur + "* (total: " + sym + formatAmount(s.total) + " — " + breakdown + ")\n";

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
              sym +
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

// Format a numeric amount for display. Rounds to a whole number and drops
// thousands separators — phone-width messages already pack currency symbol,
// amount, date, and category onto crowded lines, so "₹549" reads better than
// "₹549.50" or "₹1,234". Decimal precision was never the point of these
// summaries; if a user wants to-the-paisa accuracy they open the sheet.
function formatAmount(num) {
  return Math.round(num).toLocaleString("en-IN", { useGrouping: false });
}

// Currency-code → display prefix. Common currencies render with their symbol
// (no trailing space: "₹100", "$50", "¥1000"). Currencies without a widely
// recognized one-glyph symbol fall through to "CODE " with a trailing space
// ("AED 200", "CHF 50"). Unknown codes use the same "CODE " fallback so we
// never silently swallow a new currency.
function currencySymbol(code) {
  if (CURRENCY_SYMBOLS && Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code)) {
    return CURRENCY_SYMBOLS[code];
  }
  return (code || "") + " ";
}

// Display-only short labels for the category list. Keeps the analytics message
// narrow on phones where long names like "Health & Wellness" wrap. Unknown
// categories (custom ones the user may add) fall through to the original.
var CATEGORY_SHORT_NAMES = {
  "Food & Dining": "Food",
  "Bills & Utilities": "Bills",
  "CC Bill Payment": "CC Bill",
  "Interest/Dividend": "Interest",
  Reimbursement: "Reimburse",
  "Transfer In": "Transfer"
};

function shortCategoryName(cat) {
  return CATEGORY_SHORT_NAMES[cat] || cat;
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

function aggregateByUser(transactions) {
  var users = {};
  transactions.forEach(function (t) {
    if (!users[t.user]) users[t.user] = {};
    users[t.user][t.currency] = (users[t.user][t.currency] || 0) + t.amount;
  });
  return users;
}

// Split = 50/50 shared; Partner = payer paid 100% on behalf of other user(s).
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
