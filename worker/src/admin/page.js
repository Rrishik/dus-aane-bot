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
  <div class="seg" id="days" role="group" aria-label="Window">
    <button type="button" data-days="7">7 d</button>
    <button type="button" data-days="30" aria-pressed="true">30 d</button>
    <button type="button" data-days="90">90 d</button>
  </div>
  <button id="refresh" type="button" title="Refresh" aria-label="Refresh">↻</button>
  <span id="meta"></span>
</header>
<main id="app"><p class="muted">Loading…</p></main>
<script src="/app.js"></script>
</body>
</html>
`;

export const CSS = `
:root { color-scheme: light dark; --bg: #fafafa; --card: #fff; --fg: #1c1f26; --muted: #6e7480; --line: #e8e9ec;
  --ok: #16833a; --warn: #b26b00; --bad: #c62828; --accent: #3b6fe0; --accent2: #a9bff2; --hl: #fff4d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #171a20; --fg: #e7e9ee; --muted: #959cab;
  --line: #262a33; --accent: #7c9ef2; --accent2: #3a4f86; --hl: #3a2f12; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px max(16px, calc((100% - 1080px) / 2));
  border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; z-index: 1; }
h1 { font-size: 16px; margin: 0 8px 0 0; font-weight: 600; } h1 span { color: var(--muted); font-weight: 400; }
#meta { color: var(--muted); margin-left: auto; font-size: 12px; }
button { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
button:hover { border-color: var(--muted); }
.seg { display: inline-flex; } .seg button { border-radius: 0; margin-left: -1px; }
.seg button:first-child { border-radius: 6px 0 0 6px; } .seg button:last-child { border-radius: 0 6px 6px 0; }
.seg button[aria-pressed="true"] { background: var(--fg); color: var(--card); border-color: var(--fg); }
main { max-width: 1080px; margin: 0 auto; padding: 18px 16px 48px; display: grid; gap: 18px; }
section, details { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; }
h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
h3 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 18px 0 8px; }
summary { cursor: pointer; font-weight: 600; font-size: 13px; } summary .muted { font-weight: 400; }
details[open] summary { margin-bottom: 10px; }
.status { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.status .head { font-weight: 600; margin-right: 6px; }
.chip { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
.chip .k { color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 18px; }
.kpi b { display: block; font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--muted); font-size: 12px; display: block; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; vertical-align: top; }
th { color: var(--muted); font-weight: 500; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: 0; }
tr.click { cursor: pointer; } tr.click:hover td, tr.open td { background: var(--bg); }
tr.detail > td { background: var(--bg); white-space: normal; padding: 12px; }
.scroll { overflow-x: auto; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
.pill { display: inline-block; padding: 0 8px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; font-weight: 400; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.filters button { font-size: 12px; border-radius: 999px; padding: 1px 10px; }
.filters button[aria-pressed="true"] { background: var(--fg); color: var(--card); border-color: var(--fg); }
.case { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(280px, 1.3fr); gap: 16px; }
@media (max-width: 760px) { .case { grid-template-columns: 1fr; } }
.case table { background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.case td { white-space: normal; word-break: break-word; }
.case tr.diff td { background: var(--hl); } .case tr.diff td:first-child { font-weight: 600; }
.case .note { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
pre { margin: 0; padding: 10px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 96px; }
.chart div { flex: 1; display: flex; flex-direction: column-reverse; min-width: 3px; }
.chart i { display: block; background: var(--accent); } .chart i.b { background: var(--accent2); }
.chart div i:last-child { border-radius: 2px 2px 0 0; }
.legend { font-size: 12px; color: var(--muted); margin-top: 6px; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: var(--accent); margin: 0 4px 0 12px; vertical-align: -1px; }
.legend i.b { background: var(--accent2); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; } dt { color: var(--muted); } dd { margin: 0; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.progress { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; margin: 10px 0 0; }
.progress i { display: block; height: 100%; background: var(--accent); }
#replay .kpis { margin-top: 14px; }
details.sample { border: 0; padding: 0; margin-top: 10px; background: none; }
details.sample summary { font-weight: 400; font-size: 12px; }
details.sample .row { margin-bottom: 8px; }
`;

export const JS = `"use strict";
const $ = (s) => document.querySelector(s);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") Object.assign(n.style, v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const pct = (x) => (x == null ? "—" : Math.round(x * 1000) / 10 + "%");
function ago(ms) {
  if (!ms) return "—";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  if (m < 2880) return Math.round(m / 60) + " h ago";
  return Math.round(m / 1440) + " d ago";
}
const stamp = (ms) => (ms ? new Date(ms).toLocaleString() : "");
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

const state = { days: 30, filter: "all", openCase: null, open: new Set(), data: null };

const EVENTS = {
  shadow_mismatch: ["Disagreed", "bad"],
  shadow_nomatch: ["Parser missed", "warn"],
  shadow_extra: ["Parser only", "warn"],
  reparse_accepted: ["Re-read fixed", "bad"],
  user_fix: ["User fixed", "bad"],
  report: ["Reported", "warn"]
};
const FIELD_LABELS = [
  ["transaction_date", "Date"], ["amount", "Amount"], ["currency", "Currency"], ["transaction_type", "Type"],
  ["merchant", "Merchant"], ["account_last4", "Account"], ["reference", "Reference"]
];

function table(cols, rows, opts) {
  opts = opts || {};
  const body = [];
  if (!rows.length) body.push(el("tr", {}, el("td", { colspan: cols.length, class: "muted" }, opts.empty || "Nothing yet")));
  for (const r of rows) {
    const tr = el("tr", opts.rowAttrs ? opts.rowAttrs(r) : {}, cols.map((c) => {
      const v = c.get(r);
      return el("td", { class: (c.num ? "num " : "") + (c.cls ? c.cls(r) || "" : ""), title: c.title ? c.title(r) : null }, v == null || v === "" ? "—" : v);
    }));
    body.push(tr);
    if (opts.after) { const extra = opts.after(r, cols.length); if (extra) body.push(extra); }
  }
  return el("div", { class: "scroll" }, el("table", {},
    el("thead", {}, el("tr", {}, cols.map((c) => el("th", { class: c.num ? "num" : "" }, c.label)))),
    el("tbody", {}, body)));
}
function section(title, ...body) { return el("section", {}, title ? el("h2", {}, title) : null, body); }
function fold(key, title, count, ...body) {
  const d = el("details", { open: state.open.has(key) ? "" : null }, el("summary", {}, title, count != null ? el("span", { class: "muted" }, " · " + count) : null), body);
  d.addEventListener("toggle", () => (d.open ? state.open.add(key) : state.open.delete(key)));
  return d;
}
function bars(series, days) {
  const end = new Date(); const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(end.getTime() + 5.5 * 3600000 - i * 86400000).toISOString().slice(0, 10));
  const max = Math.max(1, ...keys.map((k) => (series.a[k] || 0) + (series.b[k] || 0)));
  const h = 96;
  return el("div", {}, el("div", { class: "chart" }, keys.map((k) => {
    const a = series.a[k] || 0, b = series.b[k] || 0;
    return el("div", { title: k + " · " + a + " " + series.la + (series.lb ? ", " + b + " " + series.lb : "") },
      el("i", { style: { height: (a / max) * h + "px" } }), series.lb ? el("i", { class: "b", style: { height: (b / max) * h + "px" } }) : null);
  })), el("div", { class: "legend" }, keys[0] + " → " + keys.at(-1), el("i", {}), series.la, series.lb ? [el("i", { class: "b" }), series.lb] : null));
}

function statuses(s, ops) {
  const w = ops.webhook || {}, p = ops.poller || {}, out = [];
  if (w.error) out.push(["bad", "Webhook", w.error]);
  else {
    const recentErr = w.lastErrorAt && Date.now() - w.lastErrorAt < 3600000;
    out.push([!w.pointsAtWorker ? "bad" : recentErr || w.pending > 5 ? "warn" : "ok", "Webhook",
      !w.pointsAtWorker ? "not pointing at the Worker" : recentErr ? w.lastError + " · " + ago(w.lastErrorAt) : w.pending ? w.pending + " pending" : "OK"]);
  }
  if (p.error) out.push(["bad", "Gmail poller", p.error]);
  else if (!p.lastRun) out.push(["warn", "Gmail poller", "no run recorded"]);
  else {
    const at = Date.parse(p.lastRun.at), failed = (p.lastRun.stats && p.lastRun.stats.failed) || 0;
    out.push([Date.now() - at > 20 * 60000 || failed ? "warn" : "ok", "Gmail poller", "ran " + ago(at) + (failed ? " · " + failed + " failed" : "")]);
  }
  if (p.retryCount) out.push(["warn", "Retry list", p.retryCount]);
  if (s.backlog.review) out.push(["warn", "Awaiting review", s.backlog.review]);
  const lf = p.lastWorkerFailure;
  if (lf && Date.now() - Date.parse(lf.at) < 86400000) out.push(["bad", "Worker failure", lf.code + " · " + ago(Date.parse(lf.at))]);
  out.push(["", "Last email", ago(s.latest.email)]);
  out.push(["", "Last SMS", ago(s.latest.sms)]);
  return out;
}

function caseDetail(c) {
  const saved = c.saved || {}, parsed = (c.parser && c.parser.values) || {};
  const rows = FIELD_LABELS.map(([k, label]) => el("tr", { class: c.changed.includes(k) ? "diff" : "" },
    el("td", {}, label), el("td", {}, c.saved ? String(saved[k] ?? "") || "—" : "—"), el("td", {}, c.parser && c.parser.read ? String(parsed[k] ?? "") || "—" : "—")));
  const notes = [];
  if (c.parser) notes.push(c.parser.read ? "Parser now: " + c.parser.template + " · confidence " + c.parser.confidence : "Parser now: no read (" + c.parser.reason + ")");
  if (c.saved) notes.push("Saved: " + [c.saved.status, c.saved.kind, c.saved.category, c.saved.merchant_clean].filter(Boolean).join(" · "));
  else notes.push("No saved transaction (not saved, or deleted).");
  if (c.fields.length) notes.push("Recorded difference: " + c.fields.join(", "));
  notes.push("Saved values include later edits; the parser column uses today's templates.");
  return el("div", { class: "case" },
    el("div", {}, el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Field"), el("th", {}, "Saved"), el("th", {}, "Parser now"))), el("tbody", {}, rows)),
      notes.map((n) => el("p", { class: "note" }, n))),
    el("div", {}, c.text != null ? el("pre", {}, c.text) : el("p", { class: "muted" }, c.textError || "No message text."),
      c.sample ? sampleBox(c.sample) : null));
}

function sampleBox(sample) {
  const status = el("span", { class: "muted" });
  const copy = el("button", { type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(sample); status.textContent = "Copied — check it before sharing."; }
    catch (_) { status.textContent = "Copy failed; select the text below."; }
  } }, "Copy masked sample");
  return el("details", { class: "sample" }, el("summary", {}, "Masked sample", el("span", { class: "muted" }, " · digits, links, addresses and names hidden")),
    el("div", { class: "row" }, copy, status), el("pre", {}, sample));
}

async function loadDetail(cell, url, stillOpen) {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const c = await res.json();
    if (stillOpen()) cell.replaceChildren(caseDetail(c));
  } catch (e) {
    cell.replaceChildren(el("p", { class: "bad" }, "Couldn't load: " + e.message));
  }
}

async function toggleCase(id) {
  state.openCase = state.openCase === id ? null : id;
  renderCases();
  if (state.openCase == null) return;
  const cell = document.getElementById("case-" + id);
  if (cell) await loadDetail(cell, "/api/case?id=" + id, () => state.openCase === id);
}

// Parser replay: pages through /api/replay; results stay in this tab.
const REPLAY_BATCH = 15, REPLAY_PARALLEL = 2, REPLAY_SHOWN = 200;
const OUTCOMES = { disagree: ["Disagreed", "bad"], missed: ["Missed", "warn"], unavailable: ["Unavailable", "muted"], agree: ["Agreed", "ok"] };
const rp = { running: false, stop: false, total: null, next: 0, items: [], error: null, started: 0, filter: "disagree", sender: null, open: null };
const domain = (s) => (s && s.includes("@") ? s.split("@")[1] : s || "(unknown)");
const money = (v) => (v ? (v.transaction_type === "Credit" ? "+" : "−") + v.currency + " " + v.amount + " · " + v.transaction_date : "—");

async function runReplay() {
  if (rp.running) { rp.stop = true; return; }
  Object.assign(rp, { running: true, stop: false, total: null, next: 0, items: [], error: null, started: Date.now(), open: null });
  renderReplay();
  async function worker() {
    while (!rp.stop && (rp.total == null || rp.next < rp.total)) {
      const offset = rp.next; rp.next += REPLAY_BATCH;
      let body = null, err = null;
      for (let attempt = 0; attempt < 2 && !body; attempt++) {
        try {
          const res = await fetch("/api/replay?offset=" + offset + "&limit=" + REPLAY_BATCH, { credentials: "same-origin" });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
          body = j;
        } catch (e) { err = e; }
      }
      if (!body) { rp.error = "Stopped at " + offset + ": " + err.message; rp.stop = true; break; }
      rp.total = body.total;
      rp.items.push(...body.items);
      renderReplay();
      if (!body.items.length) break;
    }
  }
  const first = worker();
  await new Promise((r) => setTimeout(r, 300));
  await Promise.all([first, ...Array.from({ length: REPLAY_PARALLEL - 1 }, worker)]);
  rp.running = false;
  renderReplay();
}

function tally(items, key) {
  const m = new Map();
  for (const i of items) {
    const k = key(i); if (k == null) continue;
    const t = m.get(k) || { key: k, n: 0, read: 0, agree: 0, disagree: 0, missed: 0, unavailable: 0 };
    t.n++; t[i.outcome]++; if (i.outcome === "agree" || i.outcome === "disagree") t.read++;
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

function renderReplay() {
  const host = $("#replay"); if (!host) return;
  const items = rp.items, done = items.length, total = rp.total;
  const avail = items.filter((i) => i.outcome !== "unavailable");
  const read = avail.filter((i) => i.outcome === "agree" || i.outcome === "disagree");
  const agree = read.filter((i) => i.outcome === "agree").length;
  const head = el("div", { class: "row" },
    el("button", { type: "button", onclick: runReplay }, rp.running ? "Stop" : done ? "Run again" : "Run replay"),
    el("span", { class: "muted" }, rp.running ? "Re-reading " + done + (total != null ? " / " + total : "") + " · " + Math.round((Date.now() - rp.started) / 1000) + " s"
      : done ? done + " emails re-read" : "Re-reads every stored email with today's parser and compares it with what was saved. Nothing is stored."),
    rp.error ? el("span", { class: "bad" }, rp.error) : null);
  const parts = [head];
  if (rp.running && total) parts.push(el("div", { class: "progress" }, el("i", { style: { width: Math.round((done / total) * 100) + "%" } })));
  if (done) {
    parts.push(el("div", { class: "kpis" }, [
      [pct(avail.length ? read.length / avail.length : null), "coverage", read.length + " of " + avail.length + " read by the parser"],
      [pct(read.length ? agree / read.length : null), "agreement", agree + " of " + read.length + " match what was saved"],
      [avail.length - read.length, "missed", "no parser read"],
      [done - avail.length, "unavailable", "email no longer in the inbox"]
    ].map(([v, l, sub]) => el("div", { class: "kpi" }, el("b", {}, v), el("span", {}, l), el("span", {}, sub)))));
    const rate = (t) => pct(t.read ? t.agree / t.read : null);
    parts.push(el("div", { class: "grid2" },
      el("div", {}, el("h3", {}, "By reader"), table([
        { label: "Template", get: (r) => r.key },
        { label: "Read", num: true, get: (r) => r.read },
        { label: "Disagreed", num: true, get: (r) => r.disagree, cls: (r) => (r.disagree ? "bad" : "") },
        { label: "Agreement", num: true, get: rate, cls: (r) => (r.read && r.agree / r.read >= 0.99 ? "ok" : r.read ? "warn" : "") }
      ], tally(read, (i) => i.template))),
      el("div", {}, el("h3", {}, "By sender"), table([
        { label: "Sender", get: (r) => r.key },
        { label: "Emails", num: true, get: (r) => r.n - r.unavailable },
        { label: "Read", num: true, get: (r) => r.read },
        { label: "Missed", num: true, get: (r) => r.missed, cls: (r) => (r.missed ? "warn" : "") },
        { label: "Agreement", num: true, get: rate }
      ], tally(avail, (i) => domain(i.sender)).slice(0, 15), {
        rowAttrs: (r) => ({ class: "click" + (rp.sender === r.key ? " open" : ""), title: "Show only this sender",
          onclick: () => { rp.sender = rp.sender === r.key ? null : r.key; rp.open = null; renderReplay(); } })
      }))));
    const pool = items.filter((i) => !rp.sender || domain(i.sender) === rp.sender);
    const counts = {}; for (const i of pool) counts[i.outcome] = (counts[i.outcome] || 0) + 1;
    const shown = pool.filter((i) => i.outcome === rp.filter);
    parts.push(el("h3", {}, "Emails"), el("div", { class: "filters" },
      Object.keys(OUTCOMES).map((k) => el("button", { type: "button", "aria-pressed": String(rp.filter === k),
        onclick: () => { rp.filter = k; rp.open = null; renderReplay(); } }, OUTCOMES[k][0] + " " + (counts[k] || 0))),
      rp.sender ? el("button", { type: "button", "aria-pressed": "true", title: "Clear sender filter", onclick: () => { rp.sender = null; renderReplay(); } }, rp.sender + " ✕") : null));
    parts.push(table([
      { label: "Received", get: (r) => day(r.receivedAt), title: (r) => stamp(r.receivedAt) },
      { label: "Sender", get: (r) => domain(r.sender) },
      { label: "Subject", get: (r) => (r.subject || "").slice(0, 48), title: (r) => r.subject },
      { label: "Saved", get: (r) => money(r.saved) },
      { label: "Parser", get: (r) => (r.parser ? money(r.parser) : r.reason) },
      { label: "Differs", get: (r) => (r.changed || []).join(", ") }
    ], shown.slice(0, REPLAY_SHOWN), {
      empty: "None.",
      rowAttrs: (r) => r.outcome === "unavailable" ? {} : { class: "click" + (rp.open === r.sourceId ? " open" : ""), tabindex: "0",
        onclick: () => toggleReplay(r.sourceId), onkeydown: (e) => { if (e.key === "Enter") toggleReplay(r.sourceId); } },
      after: (r, span) => rp.open === r.sourceId ? el("tr", { class: "detail" }, el("td", { colspan: span, id: "src-" + r.sourceId }, el("span", { class: "muted" }, "Loading…"))) : null
    }));
    if (shown.length > REPLAY_SHOWN) parts.push(el("p", { class: "note muted" }, "Showing " + REPLAY_SHOWN + " of " + shown.length + "."));
  }
  host.replaceChildren(el("h2", {}, "Parser replay"), ...parts);
}

async function toggleReplay(id) {
  rp.open = rp.open === id ? null : id;
  renderReplay();
  const cell = rp.open != null && document.getElementById("src-" + id);
  if (cell) await loadDetail(cell, "/api/case?source=" + id, () => rp.open === id);
}

function renderCases() {
  const host = $("#cases"); if (!host) return;
  const all = state.data.summary.parser.cases;
  const counts = {};
  for (const c of all) counts[c.event] = (counts[c.event] || 0) + 1;
  const shown = state.filter === "all" ? all : all.filter((c) => c.event === state.filter);
  const chips = [["all", "All", all.length]].concat(Object.keys(EVENTS).filter((k) => counts[k]).map((k) => [k, EVENTS[k][0], counts[k]]));
  host.replaceChildren(...[
    all.length ? el("div", { class: "filters" }, chips.map(([k, label, n]) => el("button", { type: "button", "aria-pressed": String(state.filter === k),
      onclick: () => { state.filter = k; state.openCase = null; renderCases(); } }, label + " " + n))) : null,
    table([
      { label: "When", get: (r) => ago(r.ts), title: (r) => stamp(r.ts) },
      { label: "What", get: (r) => el("span", { class: "pill " + (EVENTS[r.event] || ["", ""])[1] }, (EVENTS[r.event] || [r.event])[0]) },
      { label: "Reader", get: (r) => r.template },
      { label: "Channel", get: (r) => r.channel },
      { label: "User", get: (r) => r.user },
      { label: "Fields", get: (r) => (r.fields || "").split(",").join(", ") }
    ], shown, {
      empty: "No disagreements or corrections in this window.",
      rowAttrs: (r) => r.linked ? { class: "click" + (state.openCase === r.id ? " open" : ""), tabindex: "0", title: "Show the message",
        onclick: () => toggleCase(r.id), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCase(r.id); } } } : {},
      after: (r, span) => state.openCase === r.id ? el("tr", { class: "detail" }, el("td", { colspan: span, id: "case-" + r.id }, el("span", { class: "muted" }, "Loading…"))) : null
    }),
    all.length >= state.data.summary.parser.caseLimit ? el("p", { class: "note muted" }, "Showing the latest " + all.length + ".") : null
  ].filter(Boolean));
}

function render(d) {
  state.data = d;
  const app = $("#app"); app.replaceChildren();
  const s = d.summary, ops = d.ops || {}, p = ops.poller || {};
  const count = (kind, status) => s.tenants.filter((t) => t.kind === kind && (!status || t.status === status)).reduce((a, t) => a + t.n, 0);
  const sources = { a: {}, b: {}, la: "email", lb: "SMS" };
  let emails = 0, sms = 0;
  for (const r of s.sourcesByDay) {
    (r.source === "sms" ? sources.b : sources.a)[r.day] = r.n;
    if (r.source === "sms") sms += r.n; else emails += r.n;
  }

  const st = statuses(s, ops);
  const issues = st.filter((x) => x[0] === "bad" || x[0] === "warn").length;
  app.append(el("section", { class: "status" },
    el("span", { class: "head " + (st.some((x) => x[0] === "bad") ? "bad" : issues ? "warn" : "ok") }, issues ? issues + " need attention" : "All systems normal"),
    st.map(([cls, k, v]) => el("span", { class: "chip" }, el("i", { class: "dot " + cls }), el("span", { class: "k" }, k), el("span", {}, v)))));

  const parsers = s.parser.templates.filter((t) => t.template !== "llm");
  const match = parsers.reduce((a, t) => a + (t.events.shadow_match || 0), 0);
  const compared = parsers.reduce((a, t) => a + t.shadowCompared, 0);
  const llm = s.parser.templates.find((t) => t.template === "llm");
  app.append(section(null, el("div", { class: "kpis" },
    [
      [count("personal", "active"), "active users", count("personal", "pending") + " pending · " + count("personal", "dormant") + " dormant"],
      [count("group"), "groups", ""],
      [emails + sms, "transactions · " + s.days + " d", emails + " email · " + sms + " SMS"],
      [pct(compared ? match / compared : null), "parser agrees with LLM", "of " + compared + " compared"],
      [pct(llm ? llm.correctionRate : null), "LLM reads corrected", llm ? llm.corrections + " of " + llm.saved : "no LLM reads"]
    ].map(([v, l, sub]) => el("div", { class: "kpi" }, el("b", {}, v), el("span", {}, l), sub ? el("span", {}, sub) : null)))));

  app.append(section("Transactions per day (IST)", bars(sources, s.days)));

  app.append(section(
    ["Parser", el("span", { class: "pill muted" }, "mode: " + s.parser.mode), s.parser.disabled.length ? el("span", { class: "pill warn" }, "disabled: " + s.parser.disabled.join(", ")) : null],
    table([
      { label: "Reader", get: (r) => r.template },
      { label: "Saved", num: true, get: (r) => r.saved },
      { label: "Compared", num: true, get: (r) => r.shadowCompared },
      { label: "Agreement", num: true, get: (r) => pct(r.shadowAgreement), cls: (r) => (r.shadowAgreement == null ? "" : r.shadowAgreement >= 0.99 ? "ok" : r.shadowAgreement >= 0.9 ? "warn" : "bad") },
      { label: "Corrections", num: true, get: (r) => r.corrections ? r.corrections + " (" + pct(r.correctionRate) + ")" : 0, cls: (r) => (r.corrections ? (r.correctionRate <= 0.01 ? "ok" : "bad") : "") },
      { label: "Reports", num: true, get: (r) => r.reports }
    ], s.parser.templates),
    el("h3", {}, "Cases"),
    el("div", { id: "cases" })));
  renderCases();
  app.append(el("section", { id: "replay" }));
  renderReplay();

  app.append(fold("users", "Users", s.users.length, table([
    { label: "User", get: (r) => r.id },
    { label: "Status", get: (r) => el("span", { class: "pill " + (r.status === "active" ? "ok" : r.status === "pending" ? "warn" : "muted") }, r.status) },
    { label: "Joined", get: (r) => day(r.created_at) },
    { label: "Last active", get: (r) => ago(r.last_activity_at), title: (r) => stamp(r.last_activity_at) },
    { label: "Emails", num: true, get: (r) => r.emails },
    { label: "Txns " + s.days + " d", num: true, get: (r) => r.txns_window },
    { label: "Total", num: true, get: (r) => r.txns_total },
    { label: "SMS " + s.days + " d", num: true, get: (r) => r.sms_window },
    { label: "Review", num: true, get: (r) => r.review, cls: (r) => (r.review ? "warn" : "") },
    { label: "Groups", num: true, get: (r) => r.groups },
    { label: "/ask today · total", num: true, get: (r) => r.ask_today + " · " + r.ask_lifetime },
    { label: "Cap hits", num: true, get: (r) => r.ask_cap_hits },
    { label: "Nudges", num: true, get: (r) => r.nag_count }
  ], s.users)));

  app.append(fold("groups", "Groups", s.groups.length, table([
    { label: "Group", get: (r) => r.id },
    { label: "Status", get: (r) => r.status },
    { label: "Members", num: true, get: (r) => r.members },
    { label: "Splits " + s.days + " d", num: true, get: (r) => r.splits_window },
    { label: "Splits total", num: true, get: (r) => r.splits_total },
    { label: "Settlements " + s.days + " d", num: true, get: (r) => r.settlements_window },
    { label: "Pinned balance", get: (r) => (r.pinned ? "yes" : "no") }
  ], s.groups)));

  const recent = p.recent || [];
  app.append(fold("inbox", "Bot inbox · last " + (p.hours || 6) + " h", recent.length, table([
    { label: "When", get: (r) => r.minutesAgo + " min ago" },
    { label: "Bank?", get: (r) => (r.allowedBank ? "yes" : "no"), cls: (r) => (r.allowedBank ? "" : "muted") },
    { label: "Ignored", get: (r) => (r.ignoredByHeaders ? "yes" : "") },
    { label: "Handled", get: (r) => (r.labelled ? "yes" : r.inRetry ? "retrying" : "no"), cls: (r) => (r.labelled ? "ok" : r.inRetry ? "warn" : "") },
    { label: "Forwarder", get: (r) => r.forwarderDomain || "" }
  ], recent)));

  const w = ops.webhook || {}, lf = p.lastWorkerFailure;
  const signups = { a: {}, b: {}, la: "sign-ups", lb: "" };
  for (const r of s.signups) signups.a[r.day] = r.n;
  app.append(fold("pipeline", "Pipeline details", null, el("div", { class: "grid2" },
    el("dl", {},
      el("dt", {}, "Webhook"), el("dd", {}, w.error || ((w.pointsAtWorker ? "→ Worker" : "not the Worker") + " · pending " + (w.pending ?? "—") + (w.lastError ? " · last error: " + w.lastError + " (" + ago(w.lastErrorAt) + ")" : ""))),
      el("dt", {}, "Last poller run"), el("dd", {}, p.lastRun ? ago(Date.parse(p.lastRun.at)) + " · found " + p.lastRun.found + " · handled " + p.lastRun.stats.handled + " · failed " + p.lastRun.stats.failed : p.error || "—"),
      el("dt", {}, "Retry list"), el("dd", {}, p.retryCount ?? "—"),
      el("dt", {}, "Last Worker failure"), el("dd", {}, lf ? lf.code + " " + (lf.error || "") + " (" + ago(Date.parse(lf.at)) + ")" : "none"),
      el("dt", {}, "Apps Script triggers"), el("dd", {}, (p.triggers || []).join(", ") || "—"),
      el("dt", {}, "Backfills running"), el("dd", {}, s.backlog.backfills),
      el("dt", {}, "Short-lived state"), el("dd", {}, s.backlog.ephemeral_live + " live · " + s.backlog.ephemeral_expired + " expired"),
      el("dt", {}, "Merchant rules"), el("dd", {}, s.merchantRules.shared + " shared · " + s.merchantRules.personal + " personal")),
    el("div", {},
      table([
        { label: "Channel", get: (r) => r.source },
        { label: "Reader", get: (r) => r.reader },
        { label: "Saved", num: true, get: (r) => r.n }
      ], s.readers),
      el("h3", {}, "Sign-ups per day"), bars(signups, s.days)))));

  $("#meta").textContent = d.email + " · " + new Date(s.generatedAt).toLocaleTimeString();
}

async function load() {
  $("#meta").textContent = "Loading…";
  for (const b of document.querySelectorAll("#days button")) b.setAttribute("aria-pressed", String(Number(b.dataset.days) === state.days));
  try {
    const res = await fetch("/api/summary?days=" + state.days, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    render(await res.json());
  } catch (e) {
    $("#app").replaceChildren(el("section", {}, el("p", { class: "bad" }, "Couldn't load: " + e.message)));
    $("#meta").textContent = "";
  }
}
$("#refresh").addEventListener("click", load);
for (const b of document.querySelectorAll("#days button")) b.addEventListener("click", () => { state.days = Number(b.dataset.days); state.openCase = null; load(); });
load();
`;
