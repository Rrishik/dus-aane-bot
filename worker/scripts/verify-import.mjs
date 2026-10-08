// Sheets → D1 import, step 2: compare D1 with the import report.
//
//   node worker/scripts/verify-import.mjs --report import-report.json --wrangler [--lenient]
//   node worker/scripts/verify-import.mjs --report import-report.json \
//     --totals totals.json --owed owed.json --paid paid.json [--lenient]
//
// --wrangler runs the VERIFY_QUERIES against remote D1 (needs
// CLOUDFLARE_API_TOKEN); otherwise pass saved `wrangler d1 execute --json`
// outputs. Exit 1 on any mismatch. Prints masked ids and counts only
// (public CI logs).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { netBalances } from "../src/db/splits.js";

const WRANGLER_VERSION = "4.81.1";

export const VERIFY_QUERIES = {
  totals:
    "SELECT tenant_id, currency, direction, status = 'deleted' AS deleted, COUNT(*) AS n, SUM(amount_minor) AS amount " +
    "FROM transactions GROUP BY 1, 2, 3, 4",
  owed:
    "SELECT s.group_id AS group_id, t.currency AS currency, sh.holder_id AS debtor, s.payer_id AS creditor, SUM(sh.amount_minor) AS amount " +
    "FROM splits s JOIN split_shares sh ON sh.split_id = s.id JOIN transactions t ON t.id = s.transaction_id " +
    "WHERE sh.holder_id <> s.payer_id AND t.status <> 'deleted' GROUP BY 1, 2, 3, 4",
  paid:
    "SELECT group_id, currency, from_id AS debtor, to_id AS creditor, SUM(amount_minor) AS amount FROM settlements " +
    "WHERE from_id <> to_id GROUP BY 1, 2, 3, 4"
};

export const mask = (id) => "…" + String(id).slice(-3);

// wrangler --json prints [{ results: [...] }], sometimes after other output.
export function parseWranglerJson(text) {
  const start = String(text).indexOf("[");
  const parsed = JSON.parse(String(text).slice(start));
  return parsed.flatMap((r) => r.results || []);
}

// → list of human-readable problems (empty = match). strict: D1 must hold
// exactly the sheets' data (first import); otherwise only missing rows and
// short totals count (re-run after cutover, when the Worker has added rows
// and the user may have deleted some).
export function verifyImport(report, { totals, owed, paid }, { strict = true } = {}) {
  const problems = [];
  const actual = {};
  for (const r of totals) {
    if (strict && r.deleted) continue;
    const t = (actual[r.tenant_id] = actual[r.tenant_id] || { count: 0, sums: {} });
    t.count += r.n;
    const key = r.currency + ":" + r.direction;
    t.sums[key] = (t.sums[key] || 0) + r.amount;
  }
  const off = (a, e) => (strict ? a !== e : a < e);
  for (const [tid, exp] of Object.entries(report.expected.tenants)) {
    const act = actual[tid] || { count: 0, sums: {} };
    if (off(act.count, exp.count))
      problems.push("tenant " + mask(tid) + ": " + act.count + " rows, expected " + exp.count);
    const keys = new Set([...Object.keys(exp.sums), ...(strict ? Object.keys(act.sums) : [])]);
    for (const key of keys) {
      if (off(act.sums[key] || 0, exp.sums[key] || 0))
        problems.push("tenant " + mask(tid) + ": " + key + " total differs");
    }
  }
  if (!strict) return problems;
  for (const [gid, exp] of Object.entries(report.expected.groups)) {
    const got = netBalances(
      owed.filter((r) => r.group_id === gid),
      paid.filter((r) => r.group_id === gid)
    );
    for (const diff of diffBalances(exp, got)) problems.push("group " + mask(gid) + ": " + diff);
  }
  return problems;
}

// Per-currency differences, without amounts or ids (public logs).
export function diffBalances(expected, actual) {
  const out = [];
  const key = (e) => e.debtor + ">" + e.creditor;
  for (const ccy of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const exp = new Map((expected[ccy] || []).map((e) => [key(e), e.amountMinor]));
    const act = new Map((actual[ccy] || []).map((e) => [key(e), e.amountMinor]));
    const missing = [...exp.keys()].filter((k) => !act.has(k)).length;
    const extra = [...act.keys()].filter((k) => !exp.has(k)).length;
    const changed = [...exp.keys()].filter((k) => act.has(k) && act.get(k) !== exp.get(k)).length;
    if (missing || extra || changed) {
      out.push(
        ccy + " balances differ (" + [missing + " missing", extra + " extra", changed + " different"].join(", ") + ")"
      );
    }
  }
  return out;
}

function main() {
  const flag = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
  const report = JSON.parse(readFileSync(flag("report"), "utf8"));
  // --wrangler: query D1 directly (CI); otherwise read saved outputs.
  const read = process.argv.includes("--wrangler")
    ? (n) =>
        parseWranglerJson(
          execFileSync(
            "npx",
            [
              "--yes",
              "wrangler@" + WRANGLER_VERSION,
              "d1",
              "execute",
              "dus-aane-bot",
              "--remote",
              "--json",
              "--command",
              VERIFY_QUERIES[n]
            ],
            { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
          )
        )
    : (n) => parseWranglerJson(readFileSync(flag(n), "utf8"));
  const strict = !process.argv.includes("--lenient");
  const problems = verifyImport(report, { totals: read("totals"), owed: read("owed"), paid: read("paid") }, { strict });
  if (problems.length) {
    console.log("❌ " + problems.length + " problem(s):\n" + problems.join("\n"));
    process.exit(1);
  }
  console.log(
    "✅ D1 matches the sheets: " +
      Object.keys(report.expected.tenants).length +
      " tenants, " +
      Object.keys(report.expected.groups).length +
      " groups"
  );
}

if (process.argv[1] && process.argv[1].endsWith("verify-import.mjs")) main();
