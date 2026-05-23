// Read all transactions as structured objects.
function getAllTransactions() {
  var sheet = getSpreadsheet().getSheets()[0];
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  data.shift();

  return data.map(function (row) {
    // Transaction Date preferred, fall back to Email Date.
    var rawDate = row[TRANSACTION_DATE_COLUMN - 1] || row[EMAIL_DATE_COLUMN - 1];
    var dateObj = rawDate instanceof Date ? rawDate : new Date(rawDate);
    return {
      date: dateObj,
      merchant: (row[MERCHANT_COLUMN - 1] || "").toString(),
      amount: parseFloat(row[AMOUNT_COLUMN - 1]) || 0,
      category: (row[CATEGORY_COLUMN - 1] || "Uncategorized").toString(),
      type: (row[TRANSACTION_TYPE_COLUMN - 1] || "").toString(),
      user: (row[USER_COLUMN - 1] || "").toString(),
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

// Rolling 7-day window ending yesterday. Day-of-week independent so the
// digest is always fresh regardless of which weekday the trigger fires on.
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
  msg += "🔴 ₹" + formatAmount(inrTotal);
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

  // Top 5 categories with collapsed remainder. ₹ is anchored at a fixed
  // column so the symbol lines up vertically across rows; trailing pad
  // keeps the closing backtick uniform too.
  var sortedCats = Object.keys(data.categorySpend).sort(function (a, b) {
    return data.categorySpend[b] - data.categorySpend[a];
  });
  var topCats = sortedCats.slice(0, 5);
  var maxCatNameLen = 0;
  topCats.forEach(function (catKey) {
    var name = catKey.split("|||")[0];
    if (name.length > maxCatNameLen) maxCatNameLen = name.length;
  });
  var topAmounts = topCats.map(function (catKey) {
    return formatAmount(data.categorySpend[catKey]);
  });
  var maxAmtLen = topAmounts.reduce(function (w, a) {
    return Math.max(w, a.length);
  }, 0);
  topCats.forEach(function (catKey, idx) {
    var parts = catKey.split("|||");
    var cat = parts[0];
    var emoji = CATEGORY_EMOJIS[cat] || "•";
    var padded = cat + " ".repeat(Math.max(0, maxCatNameLen - cat.length));
    var amt = topAmounts[idx] + " ".repeat(Math.max(0, maxAmtLen - topAmounts[idx].length));
    msg += emoji + " `" + padded + "  ₹" + amt + "`\n";
  });
  if (sortedCats.length > 5) {
    var restAmount = 0;
    sortedCats.slice(5).forEach(function (catKey) {
      restAmount += data.categorySpend[catKey];
    });
    // No backslash before "+" — inside a code span Markdown escapes are
    // literal, so "\+" used to render as a visible backslash.
    var moreLabel = "+" + (sortedCats.length - 5) + " more";
    var labelPad = " ".repeat(Math.max(0, maxCatNameLen - moreLabel.length));
    var restAmt = formatAmount(restAmount);
    var restPad = " ".repeat(Math.max(0, maxAmtLen - restAmt.length));
    msg += "   `" + moreLabel + labelPad + "  ₹" + restAmt + restPad + "`\n";
  }

  if (data.topTransactions && data.topTransactions.length > 0) {
    msg += "\n💳 *Top:*\n";
    data.topTransactions.forEach(function (t, i) {
      var dateStr = t.date instanceof Date ? Utilities.formatDate(t.date, tz, "MMM dd") : t.date;
      // "1." not "1\." — legacy Markdown doesn't escape ".".
      msg +=
        i + 1 + ". " + escapeMarkdown(t.merchant || "Unknown") + "  ₹" + formatAmount(t.amount) + "  " + dateStr + "\n";
    });
  }

  return msg;
}

// ─── Trends Analytics ────────────────────────────────────────────────

function getTrendsAnalytics(numMonths) {
  numMonths = numMonths || 6;
  var all = getAllTransactions();
  var now = new Date();
  var tz = Session.getScriptTimeZone();

  var buckets = [];
  for (var i = numMonths - 1; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var year = d.getFullYear();
    var month = d.getMonth();
    var txns = filterByMonth(all, year, month);
    buckets.push(buildTrendBucket(txns, Utilities.formatDate(d, tz, "MMM yy")));
  }
  return buckets;
}

// Weekly counterpart of getTrendsAnalytics. Each bucket is a rolling 7-day
// window anchored on the same boundary as the Friday cron, then stepping
// back in 7-day blocks. Symmetric shape so formatTrendsMessage handles either.
function getWeeklyTrendsAnalytics(numWeeks) {
  numWeeks = numWeeks || 5;
  var all = getAllTransactions();
  var tz = Session.getScriptTimeZone();

  var anchor = weekRangeFor(new Date());

  var buckets = [];
  for (var i = numWeeks - 1; i >= 0; i--) {
    var end = new Date(anchor.end);
    end.setDate(end.getDate() - 7 * i);
    var start = new Date(end);
    start.setDate(end.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    var txns = filterByDateRange(all, start, end);
    // Week-start date is enough; years collide only across Dec-Jan but
    // ordering is unambiguous since buckets render oldest-to-newest.
    var label = Utilities.formatDate(start, tz, "MMM dd");
    buckets.push(buildTrendBucket(txns, label));
  }
  return buckets;
}

// Shared bucket builder for monthly + weekly trends.
function buildTrendBucket(txns, label) {
  var debits = txns.filter(function (t) {
    return t.type === "Debit";
  });
  var credits = txns.filter(function (t) {
    return t.type === "Credit";
  });

  var categorySpend = {};
  debits.forEach(function (t) {
    categorySpend[t.category] = (categorySpend[t.category] || 0) + t.amount;
  });

  return {
    label: label,
    txnCount: txns.length,
    debitByCurrency: sumByCurrency(debits),
    creditByCurrency: sumByCurrency(credits),
    categorySpend: categorySpend
  };
}

function formatTrendsMessage(buckets, opts) {
  opts = opts || {};
  var title = opts.title || "📉 *Spending Trends*";
  var comparisonLabel = opts.comparisonLabel || "vs Previous";
  var msg = title + "\n\n";

  // Each row is wrapped in a backtick code span so Telegram renders it
  // monospaced — outside a code span Telegram uses a proportional font
  // and collapses runs of spaces, so columns drift.

  var maxLabelWidth = buckets.reduce(function (w, b) {
    return Math.max(w, b.label.length);
  }, 0);

  // INR debits with bar chart. Compact "12.3K" form — the bar already
  // conveys magnitude. ₹ is anchored to a fixed column with the amount
  // left-flowing after; trailing pad keeps the closing backtick uniform.
  msg += "🔴 *Debits (INR):*\n";
  var inrAmounts = buckets.map(function (b) {
    return formatAmountCompact(b.debitByCurrency["INR"] || 0);
  });
  var maxInrWidth = inrAmounts.reduce(function (w, a) {
    return Math.max(w, a.length);
  }, 0);
  buckets.forEach(function (b, i) {
    var inr = b.debitByCurrency["INR"] || 0;
    var bar = makeBar(inr, buckets, "debit");
    var amt = inrAmounts[i].padEnd(maxInrWidth, " ");
    var label = b.label.padEnd(maxLabelWidth, " ");
    msg += "`" + label + "  " + bar + "  ₹" + amt + "`\n";
  });

  // Non-INR debits — multi-currency rows left-flow inside the code span
  // rather than column-aligning, since composition varies per row.
  var hasOtherDebits = buckets.some(function (b) {
    return Object.keys(b.debitByCurrency).some(function (c) {
      return c !== "INR";
    });
  });
  if (hasOtherDebits) {
    msg += "\n🌍 *Other Currency Debits:*\n";
    buckets.forEach(function (b) {
      var others = Object.keys(b.debitByCurrency).filter(function (c) {
        return c !== "INR" && b.debitByCurrency[c] > 0;
      });
      if (others.length > 0) {
        var parts = others.map(function (c) {
          return currencySymbol(c) + formatAmountCompact(b.debitByCurrency[c]);
        });
        msg += "`" + b.label.padEnd(maxLabelWidth, " ") + "  " + parts.join(", ") + "`\n";
      }
    });
  }

  // Credits — separate section, same code-span treatment.
  var hasCredits = buckets.some(function (b) {
    return Object.keys(b.creditByCurrency).length > 0;
  });
  if (hasCredits) {
    msg += "\n🟢 *Credits:*\n";
    buckets.forEach(function (b) {
      var curs = Object.keys(b.creditByCurrency);
      if (curs.length > 0) {
        var parts = curs.map(function (c) {
          return currencySymbol(c) + formatAmountCompact(b.creditByCurrency[c]);
        });
        msg += "`" + b.label.padEnd(maxLabelWidth, " ") + "  " + parts.join(", ") + "`\n";
      }
    });
  }

  // Period-over-period delta (debits only)
  if (buckets.length >= 2) {
    var curr = buckets[buckets.length - 1];
    var prev = buckets[buckets.length - 2];
    var currTotal = curr.debitByCurrency["INR"] || 0;
    var prevTotal = prev.debitByCurrency["INR"] || 0;

    if (prevTotal > 0) {
      var delta = currTotal - prevTotal;
      var pct = ((delta / prevTotal) * 100).toFixed(1);
      var arrow = delta >= 0 ? "📈 +" : "📉 ";
      msg +=
        "\n*" +
        comparisonLabel +
        ":* " +
        arrow +
        "₹" +
        formatAmountCompact(Math.abs(delta)) +
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
          formatAmountCompact(Math.abs(d.delta)) +
          "\n";
      });
    }
  }

  return msg;
}

// ─── Helpers ────────────────────────────────────────────────────────

// Whole rupees, no thousands separators — phone-width messages already pack
// currency symbol, amount, date, and category on crowded lines.
function formatAmount(num) {
  return Math.round(num).toLocaleString("en-IN", { useGrouping: false });
}

// Compact variant for tight columns (e.g. trends bar chart): 12345 → "12.3K".
// Sub-1K stays integer to avoid a misleading "0.5K". One decimal under 100
// keeps resolution for typical INR debits; ≥100 drops it for a 4-char ceiling.
function formatAmountCompact(num) {
  var n = Math.round(num);
  if (n < 1000) return String(n);
  if (n < 1000000) {
    var k = n / 1000;
    return (k < 100 ? k.toFixed(1) : Math.round(k).toString()) + "K";
  }
  var m = n / 1000000;
  return (m < 100 ? m.toFixed(1) : Math.round(m).toString()) + "M";
}

// Currency-code → display prefix. Common ones use their symbol ("₹100");
// the rest fall through to "CODE " with trailing space ("AED 200").
function currencySymbol(code) {
  if (CURRENCY_SYMBOLS && Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code)) {
    return CURRENCY_SYMBOLS[code];
  }
  return (code || "") + " ";
}

// Display-only short labels — keeps the analytics message narrow on phones.
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

// 8-char horizontal bar inside a Telegram code span. Uses U+2588 FULL BLOCK
// + U+2591 LIGHT SHADE specifically — these render at the same width in every
// monospace fallback. Earlier U+2593 (medium shade) rendered ~5-10% narrower
// on Android Telegram because it's pulled from a different glyph table.
//
// Min-1 rule: positive values always get ≥1 filled block so tiny-nonzero
// weeks aren't visually identical to true-zero weeks.
function makeBar(value, buckets, type) {
  var max = 0;
  buckets.forEach(function (b) {
    var bucket = type === "debit" ? b.debitByCurrency : b.creditByCurrency;
    var inr = (bucket || {})["INR"] || 0;
    if (inr > max) max = inr;
  });
  // All-zero data: render 8 empty cells so the column keeps uniform width.
  if (max === 0) return "░░░░░░░░";
  var len = Math.round((value / max) * 8);
  if (value > 0 && len === 0) len = 1;
  var bar = "";
  for (var i = 0; i < len; i++) bar += "█";
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
