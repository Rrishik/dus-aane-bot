// Run vitest with coverage instrumentation enabled in the loader, then merge
// the per-worker raw-*.json dumps into a single coverage report.
//
// Usage: `npm run coverage` (see package.json)
//
// The standard --coverage flags don't help here because tests/_loader.js
// loads Apps Script source via vm.runInContext, bypassing Node's module
// loader hooks. So we instrument the source text manually inside the loader
// and accumulate counters under globalThis.__coverage__, persisted to disk
// on process exit.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const rawDir = resolve(repoRoot, ".coverage");

if (existsSync(rawDir)) rmSync(rawDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

// Single fork keeps everything in one process so all instrumented counters
// land in one __coverage__ map. Multi-worker would still work (we'd merge
// the per-worker files below) but single-fork is simpler to reason about.
const vitestArgs = [
  "vitest",
  "run",
  "--config=./vitest.coverage.config.js",
  "--pool=forks",
  "--poolOptions.forks.singleFork=true",
  ...process.argv.slice(2)
];

const child = spawn("npx", vitestArgs, {
  cwd: repoRoot,
  env: { ...process.env, COVERAGE: "1" },
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code) => {
  const rawFiles = existsSync(rawDir)
    ? readdirSync(rawDir).filter((f) => f.startsWith("raw-") && f.endsWith(".json"))
    : [];
  if (rawFiles.length === 0) {
    console.error("\nNo coverage data collected. Did any test call loadAppsScript?");
    process.exit(code ?? 1);
  }

  const map = libCoverage.createCoverageMap({});
  for (const f of rawFiles) {
    const data = JSON.parse(readFileSync(resolve(rawDir, f), "utf8"));
    map.merge(data);
  }

  const ctx = libReport.createContext({
    dir: resolve(rawDir, "report"),
    coverageMap: map,
    defaultSummarizer: "nested"
  });

  // Console summary + html (browse .coverage/report/index.html for details).
  reports.create("text", { skipFull: false, maxCols: 120 }).execute(ctx);
  reports.create("html").execute(ctx);

  console.log(`\nHTML report: ${resolve(rawDir, "report", "index.html")}`);
  process.exit(code ?? 0);
});
