---
name: refactor
description: |
  Refactor Google Apps Script (V8) codebases while preserving behavior. Tuned
  for plain-JS Apps Script projects — flat global namespace, no modules, no
  bundler. Use when cleaning up a long handler, killing duplication, flattening
  nested conditionals, or removing dead code. Assumes pure helpers can be tested
  via a vm-sandbox loader (e.g. vitest) even though the runtime has no imports.
---

# Refactor (Google Apps Script)

Apps Script V8 runs plain JS in a single global namespace. There is no
`import`/`export`, no bundler, and the script editor itself is the deployment
target via `clasp push`. Tests, if present, run off-platform via a vm sandbox
that evals source files into a stubbed global. Pick patterns that fit that
reality — ignore class/interface/SOLID/DI advice from generic refactor guides
aimed at TypeScript/Node projects.

## Principles

1. **Behavior preservation first.** A refactor must not change observable behavior — return values, side-effect order, error surfaces. If you need a behavior change, do it as a separate `feat:` / `fix:` commit.
2. **One smell, one commit.** Don't mix "extract helper" with "rename variable" with "tweak copy". Each commit names one smell in its message.
3. **Prefer free functions over abstractions.** Apps Script projects are small and flat. A new named helper beats a class, interface, or pattern indirection almost every time.
4. **Delete, don't comment.** Git history is the archive. No `// TODO: remove later`, no commented-out branches.
5. **Lean on the safety net you have.** In order: existing tests (`npm test`) > `get_errors` > formatter > smoke test against the live deploy. If the touched code is a pure helper and tests exist for the file, add or extend a test as part of the refactor commit — it locks in behavior preservation cheaper than a smoke test.
6. **Respect the runtime, not the textbook.** Apps Script's load order, quota model, and lack of imports invalidate a lot of generic JS refactoring advice. When in doubt, defer to "Runtime constraints" below.

## Code smells (signals to refactor)

| Smell                       | What it looks like                                                                          | Fix                                            |
| --------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Long function**           | One function > ~80 lines, doing 4+ unrelated things (parse + validate + lookup + send).     | Extract function                               |
| **Deep nesting**            | More than ~2 levels of `if` inside a function, usually precondition checks.                 | Guard clauses                                  |
| **Duplicated expression**   | Same coercion / URL build / template / date math in 3+ places.                              | Extract helper                                 |
| **Magic value**             | Inline column index, status string, tab name, API URL not declared in the constants file.   | Promote to constants file                      |
| **Dead code**               | Unreachable branches, unused helpers, commented-out blocks, legacy aliases after a rename.  | Delete                                         |
| **Shotgun parameter list**  | 5+ positional args, especially with several optional/boolean flags.                         | Destructured options object                    |
| **Speculative `try/catch`** | Empty `catch` or `catch (e) { console.error(e) }` with no recovery action.                  | Remove — Apps Script logs uncaught errors      |
| **Cache bypass**            | New code calls `SpreadsheetApp.openById` / `DriveApp.getFileById` instead of cached getter. | Route through the existing lazy-cached helper  |
| **Context bypass**          | New code reads admin/global config inside a per-user/per-tenant code path.                  | Read through the per-execution context getter  |
| **Boolean parameter**       | `doThing(x, true, false, true)` at call sites with no clue what the booleans mean.          | Named flags via options object, or split funcs |

## Patterns (preferred refactors)

### 1. Extract function

A handler doing validation + lookup + message-build + send → split into named helpers in the same file. Helpers stay as plain functions; no classes.

```js
// before
function handleSomeCommand(chatId, username, messageText) {
  // 80+ lines: parse, validate, lookup, branch, send, branch, send...
}

// after
function handleSomeCommand(chatId, username, messageText) {
  var input = parseSomeCommand(messageText);
  if (!input) return sendUsage(chatId);
  if (!isValidInput(input)) return sendInvalid(chatId);
  // ...
}
```

### 2. Guard clauses

Replace nested precondition checks with early returns.

```js
// before
if (user) {
  if (user.status === ACTIVE) {
    if (user.sheet_id) doWork();
  }
}

// after
if (!user) return;
if (user.status !== ACTIVE) return;
if (!user.sheet_id) return;
doWork();
```

### 3. Extract helper for duplicated expression

Common candidates in Apps Script projects:

- ID coercion: `String(a) === String(b)` → `sameId(a, b)`
- URL builders: `"https://docs.google.com/spreadsheets/d/" + id` → `sheetUrl(id)`
- Date math: `new Date(Date.now() - n * 24 * 3600 * 1000)` → `daysAgo(n)`
- A1 ranges: `"A" + row + ":Z" + row` → `rowRange(row)`

Place the helper in the file most naturally related to its domain, and ensure that file loads before all callers per `filePushOrder`.

### 4. Promote magic value to constants

Column indexes, status enums, tab names, API endpoints — all live in one constants file. Move new magic values there even if used in only one place; future grep-driven changes stay safe.

### 5. Options object for wide signatures

```js
// before
sendMessage(chatId, text, true, false, "Markdown", null, replyId);

// after
sendMessage(chatId, text, { silent: true, parseMode: "Markdown", replyTo: replyId });
```

Only worth doing past 4-5 args, or when boolean flags appear.

### 6. Delete dead code

Remove legacy aliases, unused branches, and `// TODO`s as part of the refactor. Anything genuinely needed later lives in git history.

## Anti-patterns (avoid in Apps Script)

- **Classes / inheritance / Strategy / Chain of Responsibility / Visitor.** Indirection costs more than it saves in a small flat codebase.
- **TypeScript-style type passes.** No build step. JSDoc on hot helpers is fine; full structural typing isn't.
- **Splitting a file because it's "long".** Aim for ~400-500 line files; only split when there's a clean domain boundary.
- **Speculative `try/catch`.** Catch only with a real recovery path or a specific known failure to swallow.
- **Renaming files mid-refactor.** Combines badly with `clasp push`'s no-delete behavior. Do renames in their own commit and follow up with manual editor cleanup.
- **Dependency injection / service locators.** A flat global namespace is itself the registry; faking modules makes the code harder to read.

## Runtime constraints (don't break these)

1. **`const`/`let` don't hoist across files.** All `.js`/`.gs` files share one global scope, but they're concatenated in `.clasp.json` → `filePushOrder` order (falling back to alphabetical/manifest order). A `const` defined in file B is in the **TDZ** for top-level code in file A if A loads first. Config/constants files must load before consumers. Don't reshuffle load order during a refactor.
2. **Single global namespace.** Function/const names must be unique repo-wide. Renaming a helper means grepping the whole project. A new global helper with the same name as a local `var` will shadow it (or trip "redeclaration" at the top level).
3. **`clasp push` only adds/updates.** Renaming a file in the repo leaves the old copy in the script editor — manually delete the orphan or you'll have two copies and the wrong one may win.
4. **Quota-billed APIs.** `SpreadsheetApp.openById`, `DriveApp.getFileById`, `UrlFetchApp.fetch`, `GmailApp.search` cost daily quota. If the codebase has lazy-cached accessors, route through them — don't re-resolve per call.
5. **Legacy Markdown parse modes.** If the codebase uses `parse_mode: "Markdown"` (not MarkdownV2), don't escape `.`/`-`/`!` and don't switch parse modes during a refactor — escape rules differ.
6. **Per-execution context globals.** When a global holds current user / tenant / locale for one execution, refactored helpers must keep reading through the existing accessor — never bypass to read raw config from inside a user/tenant request, or you'll cross-leak data.
7. **Triggers and webhooks are entry points.** A function called from a time-driven trigger, `doPost`, or `doGet` is a contract boundary. Refactors that change its signature must update the trigger registration too.

## Testing model

Apps Script source files have no `module.exports`. Tests run off-platform by reading source files as text and `vm.runInContext`-ing them into a sandbox where Apps Script services (`SpreadsheetApp`, `UrlFetchApp`, `GmailApp`, `DriveApp`, `Logger`, etc.) are stubbed. After eval, named symbols are plucked from the sandbox.

Implications for refactoring:

- **Pure helpers are first-class testable.** When you extract a helper that takes plain values in and returns plain values out, write a vitest case for it through the loader. This is the cheapest behavior-preservation guarantee available.
- **Service-touching code is hard to test.** Anything calling `SpreadsheetApp.openById`, `UrlFetchApp.fetch`, `GmailApp.search` requires per-test stubs. If a refactor moves logic from a service-touching function into a new pure helper, the new helper becomes covered \u2014 a real win.
- **Don't break loader-friendliness.** No top-level side effects in source files (no `SpreadsheetApp.openById(...)` at module scope). All such calls must live inside functions, so the loader can eval the file without invoking Apps Script.
- **Test-only stubs go in a shared mock file** (e.g. `tests/_sheetMock.js`), not inline per test.

## Process

1. **Map the call sites.** `grep_search` the symbol name across the whole repo (no imports means callers can be anywhere). The new contract must work for every caller.
2. **Check for shadowing.** Before introducing a new global helper, `grep_search` the proposed name. Rename any existing local `var <name>` to something else (e.g. `url`, `id`) in the same commit.
3. **Run tests first to capture green baseline.** `npm test` (or repo equivalent) before touching code, so any post-refactor failure is clearly attributable.
4. **Make the change.** One smell, one commit.
5. **Add/extend a test if you extracted a pure helper.** Pure helpers (no `SpreadsheetApp` / `UrlFetchApp` / `GmailApp` / `DriveApp` calls and no global mutation) are cheap to cover via the repo's vm-sandbox loader. If the helper touches Apps Script services, stub them in the loader rather than testing through them.
6. **`get_errors` on touched files.** Catches typos, undefined refs, accidental shadowing.
7. **Run tests + formatter.** `npm test` must stay green. `npx prettier --write <files>` if `.prettierrc` exists. CI rejects otherwise.
8. **Commit with `refactor:` prefix** naming the smell (`extract method`, `guard clauses`, `dedupe URL builder`, `kill dead code`).
9. **Push and watch the deploy.** If CI auto-deploys via `clasp push`, watch the Apps Script Executions panel for new errors after the next trigger fires or webhook hits.
10. **Smoke test the affected entry point** for any code path tests don't cover (anything calling `SpreadsheetApp` / Telegram / Gmail). Send the command / trigger / webhook payload manually; confirm same output as before.
11. **If a deploy looks wrong:** `git revert <sha> && git push`. Apps Script only deploys forward; you can't roll back a deployment, only deploy a fix.

## Checklist

- [ ] No behavior change (callers see same return / same side-effects in same order).
- [ ] No new top-level `var`/`const` that shadows or collides with an existing global.
- [ ] All new helpers are reachable / used.
- [ ] New helper's defining file loads before all consumers per `filePushOrder`.
- [ ] Magic values moved to the project's constants file (or justified inline).
- [ ] `get_errors` clean on touched files.
- [ ] `npm test` green (or test added/updated for any new pure helper).
- [ ] Formatter passes.
- [ ] Commit message starts with `refactor:` and names the smell.
- [ ] Smoke-test plan in commit body for any code path tests don't cover.
