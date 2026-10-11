// Admin dashboard assets. Served as separate files so the CSP can forbid
// inline script; the JS renders everything with textContent.

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Dus Aane Bot — admin</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
  <h1>Dus Aane Bot <span>admin</span></h1>
  <label>Window
    <select id="days">
      <option value="7">7 days</option>
      <option value="30" selected>30 days</option>
      <option value="90">90 days</option>
    </select>
  </label>
  <button id="refresh" type="button">Refresh</button>
  <span id="meta"></span>
</header>
<main id="app"><p class="muted">Loading…</p></main>
<script src="/app.js"></script>
</body>
</html>
`;

export const CSS = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1d2330; --muted: #6b7385; --line: #e3e6ec;
  --ok: #1a7f37; --warn: #b26b00; --bad: #c62828; --bar: #3b6fe0; --bar2: #8aa8ef; }
@media (prefers-color-scheme: dark) { :root { --bg: #11141a; --card: #1a1f28; --fg: #e6e9ef; --muted: #9aa3b5;
  --line: #2a3140; --bar: #6d93f0; --bar2: #3d5aa8; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; }
h1 { font-size: 17px; margin: 0 12px 0 0; } h1 span { color: var(--muted); font-weight: 400; }
#meta { color: var(--muted); margin-left: auto; font-size: 12px; }
select, button { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
button { cursor: pointer; }
main { padding: 16px 20px 40px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; }
section.wide { grid-column: 1 / -1; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 10px; }
.kpis { display: flex; flex-wrap: wrap; gap: 18px; }
.kpi b { display: block; font-size: 22px; } .kpi span { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 90px; margin-top: 6px; }
.chart div { flex: 1; display: flex; flex-direction: column-reverse; min-width: 3px; }
.chart i { display: block; background: var(--bar); } .chart i.b { background: var(--bar2); }
.legend { font-size: 12px; color: var(--muted); margin-top: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; background: var(--bar); margin: 0 4px 0 10px; vertical-align: -1px; }
.legend i.b { background: var(--bar2); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; } dt { color: var(--muted); }
`;

export const JS = `"use strict";
const $ = (s) => document.querySelector(s);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "style") Object.assign(n.style, v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const pct = (x) => (x == null ? "—" : Math.round(x * 1000) / 10 + "%");
function ago(ms) {
  if (!ms) return "—";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return m + " min ago";
  if (m < 2880) return Math.round(m / 60) + " h ago";
  return Math.round(m / 1440) + " d ago";
}
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
function card(title, body, wide) { return el("section", { class: wide ? "wide" : "" }, el("h2", {}, title), body); }
function table(cols, rows) {
  return el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, cols.map((c) => el("th", { class: c.num ? "num" : "" }, c.label)))),
    el("tbody", {}, rows.length ? rows.map((r) => el("tr", {}, cols.map((c) => {
      const v = c.get(r);
      return el("td", { class: (c.num ? "num " : "") + (c.cls ? c.cls(r) || "" : "") }, v == null ? "—" : v);
    }))) : el("tr", {}, el("td", { colspan: cols.length, class: "muted" }, "Nothing yet")))));
}
function kpis(items) { return el("div", { class: "kpis" }, items.map(([v, l, cls]) => el("div", { class: "kpi" }, el("b", { class: cls || "" }, v), el("span", {}, l)))); }
function bars(series, days) {
  const end = new Date(); const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(end.getTime() + 5.5 * 3600000 - i * 86400000).toISOString().slice(0, 10));
  const max = Math.max(1, ...keys.map((k) => (series.a[k] || 0) + (series.b[k] || 0)));
  return el("div", {}, el("div", { class: "chart" }, keys.map((k) => {
    const a = series.a[k] || 0, b = series.b[k] || 0;
    return el("div", { title: k + ": " + a + " " + series.la + ", " + b + " " + series.lb },
      el("i", { style: { height: (a / max) * 90 + "px" } }), el("i", { class: "b", style: { height: (b / max) * 90 + "px" } }));
  })), el("div", { class: "legend" }, keys[0] + " → " + keys.at(-1), el("i", {}), series.la, el("i", { class: "b" }), series.lb));
}

function render(d) {
  const app = $("#app"); app.replaceChildren();
  const s = d.summary, ops = d.ops || {};
  const count = (kind, status) => s.tenants.filter((t) => t.kind === kind && (!status || t.status === status)).reduce((a, t) => a + t.n, 0);
  const sources = { a: {}, b: {}, la: "email", lb: "SMS" };
  for (const r of s.sourcesByDay) (r.source === "sms" ? sources.b : sources.a)[r.day] = r.n;
  const inWindow = s.sourcesByDay.reduce((a, r) => a + r.n, 0);

  app.append(card("Overview", kpis([
    [count("personal", "active"), "active users"],
    [count("personal", "pending"), "pending"],
    [count("personal", "dormant"), "dormant"],
    [count("group"), "groups"],
    [inWindow, "transactions in " + s.days + " d"],
    [s.backlog.review, "awaiting review", s.backlog.review ? "warn" : ""]
  ]), true));

  app.append(card("Transactions per day (IST)", bars(sources, s.days), true));

  const p = ops.poller || {};
  const w = ops.webhook || {};
  const lastFail = p.lastWorkerFailure;
  const health = el("dl", {},
    el("dt", {}, "Telegram webhook"), el("dd", {}, w.error ? el("span", { class: "bad" }, w.error) :
      [el("span", { class: w.pointsAtWorker ? "ok" : "bad" }, w.pointsAtWorker ? "→ Worker" : "not the Worker"),
       " · pending " + (w.pending ?? "—") + (w.lastError ? " · last error: " + w.lastError + " (" + ago(w.lastErrorAt) + ")" : "")]),
    el("dt", {}, "Gmail poller"), el("dd", {}, p.error ? el("span", { class: "bad" }, p.error) :
      [p.lastRun ? "last run " + ago(Date.parse(p.lastRun.at)) + " · found " + p.lastRun.found + " · handled " + p.lastRun.stats.handled + " · failed " + p.lastRun.stats.failed : "no run recorded"]),
    el("dt", {}, "Retry list"), el("dd", { class: p.retryCount ? "warn" : "" }, p.retryCount ?? "—"),
    el("dt", {}, "Last Worker failure"), el("dd", {}, lastFail ? lastFail.code + " " + (lastFail.error || "") + " (" + ago(Date.parse(lastFail.at)) + ")" : "none"),
    el("dt", {}, "Apps Script triggers"), el("dd", {}, (p.triggers || []).join(", ") || "—"),
    el("dt", {}, "Latest email / SMS"), el("dd", {}, ago(s.latest.email) + " / " + ago(s.latest.sms)),
    el("dt", {}, "Backfills running"), el("dd", {}, s.backlog.backfills),
    el("dt", {}, "Short-lived state"), el("dd", {}, s.backlog.ephemeral_live + " live, " + s.backlog.ephemeral_expired + " expired (purged daily)"));
  app.append(card("Ingestion health", health));

  const recent = (p.recent || []);
  app.append(card("Bot inbox, last " + (p.hours || 6) + " h", table([
    { label: "When", get: (r) => r.minutesAgo + " min ago" },
    { label: "Bank?", get: (r) => (r.allowedBank ? "yes" : "no"), cls: (r) => (r.allowedBank ? "" : "muted") },
    { label: "Ignored", get: (r) => (r.ignoredByHeaders ? "yes" : "") },
    { label: "Handled", get: (r) => (r.labelled ? "yes" : r.inRetry ? "retrying" : "no"), cls: (r) => (r.labelled ? "ok" : r.inRetry ? "warn" : "") },
    { label: "Forwarder", get: (r) => r.forwarderDomain || "" }
  ], recent)));

  app.append(card("Parser — mode " + s.parser.mode + (s.parser.disabled.length ? " · disabled: " + s.parser.disabled.join(", ") : ""), table([
    { label: "Reader", get: (r) => r.template },
    { label: "Saved", num: true, get: (r) => r.saved },
    { label: "Shadow compared", num: true, get: (r) => r.shadowCompared },
    { label: "Agreement", num: true, get: (r) => pct(r.shadowAgreement), cls: (r) => (r.shadowAgreement == null ? "" : r.shadowAgreement >= 0.99 ? "ok" : r.shadowAgreement >= 0.9 ? "warn" : "bad") },
    { label: "Corrections", num: true, get: (r) => r.corrections },
    { label: "Correction rate", num: true, get: (r) => pct(r.correctionRate), cls: (r) => (r.correctionRate ? (r.correctionRate <= 0.01 ? "ok" : "bad") : "") },
    { label: "Reports", num: true, get: (r) => r.reports }
  ], s.parser.templates), true));

  app.append(card("Fields that differed", table([
    { label: "Reader", get: (r) => r.template },
    { label: "Event", get: (r) => r.event },
    { label: "Fields", get: (r) => r.fields },
    { label: "Count", num: true, get: (r) => r.n }
  ], s.parser.fields)));

  app.append(card("Who read saved transactions", table([
    { label: "Channel", get: (r) => r.source },
    { label: "Reader", get: (r) => r.reader },
    { label: "Count", num: true, get: (r) => r.n }
  ], s.readers)));

  app.append(card("Users (masked)", table([
    { label: "User", get: (r) => r.id },
    { label: "Status", get: (r) => el("span", { class: "pill " + (r.status === "active" ? "ok" : r.status === "pending" ? "warn" : "muted") }, r.status) },
    { label: "Joined", get: (r) => day(r.created_at) },
    { label: "Last activity", get: (r) => ago(r.last_activity_at) },
    { label: "Emails", num: true, get: (r) => r.emails },
    { label: "Txns (" + s.days + " d)", num: true, get: (r) => r.txns_window },
    { label: "Txns total", num: true, get: (r) => r.txns_total },
    { label: "SMS (" + s.days + " d)", num: true, get: (r) => r.sms_window },
    { label: "Review", num: true, get: (r) => r.review, cls: (r) => (r.review ? "warn" : "") },
    { label: "Groups", num: true, get: (r) => r.groups },
    { label: "/ask today", num: true, get: (r) => r.ask_today },
    { label: "/ask total", num: true, get: (r) => r.ask_lifetime },
    { label: "Cap hits", num: true, get: (r) => r.ask_cap_hits },
    { label: "Nudges", num: true, get: (r) => r.nag_count }
  ], s.users), true));

  app.append(card("Groups (masked)", table([
    { label: "Group", get: (r) => r.id },
    { label: "Status", get: (r) => r.status },
    { label: "Members", num: true, get: (r) => r.members },
    { label: "Splits (" + s.days + " d)", num: true, get: (r) => r.splits_window },
    { label: "Splits total", num: true, get: (r) => r.splits_total },
    { label: "Settlements (" + s.days + " d)", num: true, get: (r) => r.settlements_window },
    { label: "Pinned balance", get: (r) => (r.pinned ? "yes" : "no") }
  ], s.groups)));

  app.append(card("Merchant rules", kpis([[s.merchantRules.shared, "shared defaults"], [s.merchantRules.personal, "personal corrections"]])));

  const signups = { a: {}, b: {}, la: "sign-ups", lb: "" };
  for (const r of s.signups) signups.a[r.day] = r.n;
  app.append(card("Sign-ups per day (IST)", bars(signups, s.days)));

  $("#meta").textContent = "Signed in as " + d.email + " · updated " + new Date(s.generatedAt).toLocaleTimeString();
}

async function load() {
  $("#meta").textContent = "Loading…";
  try {
    const res = await fetch("/api/summary?days=" + $("#days").value, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    render(await res.json());
  } catch (e) {
    $("#app").replaceChildren(el("section", { class: "wide" }, el("p", { class: "bad" }, "Couldn't load: " + e.message)));
    $("#meta").textContent = "";
  }
}
$("#refresh").addEventListener("click", load);
$("#days").addEventListener("change", load);
load();
`;
