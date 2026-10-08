// D1-compatible test double backed by node:sqlite (D1 is SQLite).
//
// Mirrors the D1 surface the Worker uses: prepare().bind().first/all/run/raw,
// batch() (transactional, like D1), exec(). Foreign keys are enforced as in
// D1. `undefined` binds throw, as D1 does, so missing args fail loudly.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Loaded via require: Vite 5 doesn't recognise node:sqlite as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

function normalizeParam(v) {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function plain(row) {
  return row ? { ...row } : row;
}

class FakeStatement {
  constructor(sqlite, sql, params) {
    this._sqlite = sqlite;
    this._sql = sql;
    this._params = params || [];
  }

  bind(...params) {
    return new FakeStatement(this._sqlite, this._sql, params.map(normalizeParam));
  }

  _returnsRows() {
    return /^\s*(select|with|pragma)\b/i.test(this._sql) || /\breturning\b/i.test(this._sql);
  }

  _exec() {
    var stmt = this._sqlite.prepare(this._sql);
    if (this._returnsRows()) {
      var rows = stmt.all(...this._params).map(plain);
      return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
    }
    var info = stmt.run(...this._params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }
    };
  }

  async first(column) {
    var row = this._sqlite.prepare(this._sql).get(...this._params);
    if (!row) return null;
    return column ? row[column] : plain(row);
  }

  async all() {
    return this._exec();
  }

  async run() {
    return this._exec();
  }

  async raw() {
    return this._exec().results.map((r) => Object.values(r));
  }
}

export class FakeD1 {
  constructor(sqlite) {
    this._sqlite = sqlite;
  }

  prepare(sql) {
    return new FakeStatement(this._sqlite, sql);
  }

  async batch(statements) {
    this._sqlite.exec("BEGIN");
    try {
      var results = statements.map((s) => s._exec());
      this._sqlite.exec("COMMIT");
      return results;
    } catch (e) {
      this._sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql) {
    this._sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
}

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
}

// Fresh in-memory database with every migration applied.
export function createTestD1() {
  var sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  migrationFiles().forEach((f) => sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")));
  return new FakeD1(sqlite);
}
