// Test-only loader for Apps Script source files.
//
// The production .js files have no `module.exports` (Apps Script V8 has a flat
// global namespace). This loader reads a source file as text and evaluates it
// inside a sandbox where Apps Script globals can be stubbed, then returns the
// requested symbols. Production files are not modified.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

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
  vm.createContext(sandbox);
  for (const f of files) {
    const src = readFileSync(resolve(repoRoot, f), "utf8");
    vm.runInContext(src, sandbox, { filename: f });
  }
  const out = {};
  for (const s of symbols) out[s] = sandbox[s];
  return out;
}
