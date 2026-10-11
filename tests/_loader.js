// Test-only loader for Apps Script source files.
//
// The production .js files have no `module.exports` (Apps Script V8 has a flat
// global namespace). This loader reads a source file as text and evaluates it
// inside a sandbox where Apps Script globals can be stubbed, then returns the
// requested symbols. Production files are not modified.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Coverage support: when COVERAGE=1, instrument each loaded file with
// istanbul before evaluation and accumulate counters in a per-process map.
// The standard vitest/v8/istanbul providers can't see code that goes through
// vm.runInContext — they only instrument the module loader path — so we do
// it ourselves here. scripts/coverage.js spawns vitest with COVERAGE=1 then
// reads the on-disk JSON dropped by the exit hook below.
const COVERAGE_ENABLED = process.env.COVERAGE === "1";
let _instrumenter = null;

async function getInstrumenter() {
  if (!_instrumenter) {
    const mod = await import("istanbul-lib-instrument");
    _instrumenter = mod.createInstrumenter({
      esModules: false,
      produceSourceMap: false,
      compact: false
    });
  }
  return _instrumenter;
}

function ensureExitHook() {
  // Use a process-level marker (instead of a module-level let) so we register
  // exactly one listener per OS process, even when vitest re-evaluates the
  // loader module across test files (each evaluation has its own globalThis).
  if (process.__appsScriptCoverageHook) return;
  process.__appsScriptCoverageHook = true;
  // 'exit'/'beforeExit' don't fire reliably for vitest workers (they exit
  // via IPC disconnect), so the primary flush trigger is the afterAll hook
  // in tests/_coverageSetup.js. These handlers are a belt-and-suspenders
  // fallback for direct (non-vitest) loader use.
  const handler = () => writeCoverageSnapshot();
  process.on("beforeExit", handler);
  process.on("exit", handler);
}

// Snapshot writer: overwrite a single per-pid file. Istanbul counters only
// grow, so the latest snapshot is always the most complete. scripts/coverage.js
// merges across pids.
function writeCoverageSnapshot() {
  if (!globalThis.__coverage__ || Object.keys(globalThis.__coverage__).length === 0) return;
  try {
    const outDir = resolve(repoRoot, ".coverage");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `raw-${process.pid}.json`), JSON.stringify(globalThis.__coverage__));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[coverage] snapshot write failed: ${e.message}`);
  }
}

// Expose for the afterAll hook in tests/_coverageSetup.js.
if (COVERAGE_ENABLED) globalThis.__appsScriptFlushCoverage = writeCoverageSnapshot;

// Top-level await is allowed in ESM and is fine here — vitest workers wait
// for the module to finish loading before running tests. Without this, the
// first loadAppsScript call would have to be async, which would force every
// test file to change signatures.
const _instrumenterReady = COVERAGE_ENABLED ? getInstrumenter() : Promise.resolve(null);
const _resolvedInstrumenter = await _instrumenterReady;

/**
 * Load one or more Apps Script source files into a fresh sandbox and return
 * the named exports.
 *
 * @param {string[]} files       Repo-relative .js paths to concatenate + eval.
 * @param {string[]} symbols     Names to pluck out of the sandbox after eval.
 * @param {object}  [stubs]      Extra globals to inject (e.g. SpreadsheetApp).
 * @returns {object}             { [symbol]: value }
 */
export function loadAppsScript(files, symbols, stubs = {}) {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    ...stubs
  };
  if (COVERAGE_ENABLED) {
    // Share the per-process accumulator with the sandbox so instrumented
    // counters increment the same maps across loadAppsScript calls. Istanbul's
    // preamble checks for an existing entry under __coverage__[filePath] and
    // reuses it, so counts merge naturally.
    if (!globalThis.__coverage__) globalThis.__coverage__ = {};
    sandbox.__coverage__ = globalThis.__coverage__;
    ensureExitHook();
  }
  vm.createContext(sandbox);
  for (const f of files) {
    const fullPath = resolve(repoRoot, f);
    const raw = readFileSync(fullPath, "utf8");
    const code = COVERAGE_ENABLED ? _resolvedInstrumenter.instrumentSync(raw, fullPath) : raw;
    vm.runInContext(code, sandbox, { filename: fullPath });
  }
  const out = {};
  for (const s of symbols) out[s] = sandbox[s];
  return out;
}
