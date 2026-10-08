// Sheets → D1 import, step 1: fetch the dump from Apps Script and write SQL.
//
//   node worker/scripts/import-sheets.mjs --out import.sql --report import-report.json
//     [--dump dump.json]       read a saved dump instead of calling Apps Script
//     [--save-dump dump.json]  keep the fetched dump (contains personal data!)
//
// Env when fetching: APPS_SCRIPT_URL, INTERNAL_SECRET. Output on stdout is
// aggregate counts only: this runs in public CI logs.
import { readFileSync, writeFileSync } from "node:fs";
import { callAppsScript } from "../src/app/appsScript.js";
import { buildImport } from "./import/sheets.mjs";

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : null;
}

async function loadDump() {
  if (arg("dump")) return JSON.parse(readFileSync(arg("dump"), "utf8"));
  const ctx = { env: process.env, now: () => Date.now(), fetch: (...a) => fetch(...a) };
  const res = await callAppsScript(ctx, "export_dump", {});
  if (arg("save-dump")) writeFileSync(arg("save-dump"), JSON.stringify(res.dump));
  return res.dump;
}

export function summarize(report) {
  const reasons = {};
  for (const s of report.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  const warnings = {};
  for (const w of report.warnings) warnings[w.replace(/:.*/, "")] = (warnings[w.replace(/:.*/, "")] || 0) + 1;
  return [
    "tenants: " + report.tenants + ", groups: " + report.groups,
    "transactions: " + report.transactions + ", splits: " + report.splits + ", settlements: " + report.settlements,
    "merchant rules: " + report.rules,
    "skipped rows: " + (report.skipped.length ? JSON.stringify(reasons) : "none"),
    "warnings: " + (report.warnings.length ? JSON.stringify(warnings) : "none")
  ].join("\n");
}

async function main() {
  const out = arg("out") || "import.sql";
  const reportPath = arg("report") || "import-report.json";
  const dump = await loadDump();
  const { sql, report } = buildImport(dump);
  writeFileSync(out, sql.join("\n") + "\n");
  writeFileSync(reportPath, JSON.stringify(report));
  console.log(summarize(report));
  console.log(sql.length + " statements → " + out);
}

if (process.argv[1] && process.argv[1].endsWith("import-sheets.mjs")) {
  main().catch((e) => {
    console.error("import failed:", e.message);
    process.exit(1);
  });
}
