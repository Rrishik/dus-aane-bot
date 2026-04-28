---
name: refactor
description: |
  Refactor code in the dus-aane-bot Apps Script codebase while preserving behavior.
  Tuned for plain-JS Apps Script (no modules, no tests, no build step). Use when
  cleaning up a long handler, killing duplication, flattening nested conditionals,
  or removing dead code in this repo.
---

# Refactor (dus-aane-bot)

Apps Script V8, plain JS, free functions in a flat global namespace. No tests,
no `import`/`export`, no TypeScript. Pick patterns that fit that reality —
ignore class/interface/SOLID advice from generic refactor guides.

## When this applies

- A handler in `BotHandlers.js` / `Onboarding.js` / `Code.js` is over ~80 lines or doing 4+ unrelated things.
- The same coercion / lookup / message template appears in 3+ places.
- A function has more than ~2 levels of nested `if`s.
- Magic numbers/strings appear in code instead of `Constants.js`.
- Legacy aliases or commented-out code remain after a refactor.

## Apps Script gotchas (don't break these)

1. **`const`/`let` don't hoist across files.** Files load in the order in `.clasp.json` → `filePushOrder`. Configure file (`AConfig.js`) must load first; `Constants.js` next; everything else after. Don't reshuffle.
2. **No imports — global namespace.** Function/const names must be unique across the whole project. Renaming a helper means grepping the whole repo.
3. **`clasp push` only adds/updates.** Renaming a file in the repo leaves the old one in the script editor — must be deleted manually after deploy.
4. **Caching matters.** `_cachedSpreadsheet` (tenant) and `_cachedAdminSpreadsheet` (admin) avoid quota burn. Don't refactor in ways that re-resolve the spreadsheet per call.
5. **Markdown parse mode is legacy "Markdown", not MarkdownV2.** Don't escape `.` and `-`. Don't switch parse modes during a refactor.
6. **Tenant context is global state** (`setCurrentTenant` / `getCurrentTenant`). Refactors that move work into helpers must keep using `getTenantSheetId()` / `getTenantChatId()` — never read `ADMIN_*` directly from a code path that runs inside a tenant request.

## Patterns that fit this codebase

### 1. Extract function from a long handler

A handler doing validation + lookup + message-build + send → split into named helpers in the same file. Helpers stay as plain functions; don't introduce classes.

```js
// before
function handleRegisterCommand(chatId, username, messageText) {
  // 80 lines: parse, validate, lookup, branch, send, branch, send...
}

// after
function handleRegisterCommand(chatId, username, messageText) {
  var email = parseRegisterEmail(messageText);
  if (!email) return sendRegisterUsage(chatId);
  if (!isValidEmail(email)) return sendInvalidEmail(chatId);
  // ...
}
```

### 2. Guard clauses over nested ifs

Nesting in this codebase usually means tenant/state checks. Flatten with early returns.

```js
// before
if (tenant) {
  if (tenant.status === ACTIVE) {
    if (tenant.sheet_id) {
      doWork();
    }
  }
}

// after
if (!tenant) return;
if (tenant.status !== ACTIVE) return;
if (!tenant.sheet_id) return;
doWork();
```

### 3. Promote magic strings/numbers to `Constants.js`

Column indexes, status enums, tab names — all live in `Constants.js`. New magic value → add it there, even if used in only one place.

### 4. Kill duplicated coercion / template

`String(tenant.chat_id) !== String(chatId)` appears in multiple places. Extract `sameChatId(a, b)` once. Same for `https://docs.google.com/spreadsheets/d/${id}` URL building.

### 5. Delete dead code, don't comment it out

Git history is the archive. Remove legacy aliases (the recent `CHAT_ID` / `SHEET_ID` cleanup is the template). Don't leave `// TODO: remove later`.

## Patterns to avoid here

- **Classes / inheritance / Strategy / Chain of Responsibility.** This is a small, flat codebase; OOP indirection makes it harder to follow, not easier.
- **TypeScript-style "introduce types".** No build step. JSDoc on hot helpers is fine; full typing isn't.
- **Splitting one file into many because it's "long".** Apps Script load-order pain isn't worth it. Aim for ~400-line files; only split if there's a clean domain boundary (e.g. `TenantRegistry.js` is its own thing).
- **Parameter objects for 2-3 args.** Only worth it past 4-5 args.
- **Adding `try/catch` "just in case".** Apps Script logs uncaught errors to Stackdriver already. Catch only when you have a real recovery path.

## Safe-refactor process for this repo

There are no tests. The safety net is:

1. **Read the function and its callers** (`grep_search` the symbol). Note every call site.
2. **Make the change in one focused commit.** No mixing refactor with feature/copy changes.
3. **Run `get_errors` on touched files.** Catches typos and undefined refs early.
4. **`npx prettier --write <files>`** before committing. CI will reject otherwise.
5. **Commit with `refactor:` prefix** and name the smell in the body (`extract method`, `guard clauses`, `kill dead code`).
6. **Push to `main`** — CI auto-deploys to Apps Script + Cloudflare Worker.
7. **Smoke test in Telegram:** send the affected command (`/start`, `/recent`, etc.) and check Apps Script → Executions for errors.
8. **If a deploy looks wrong:** `git revert <sha> && git push`. Apps Script redeploys forward; you can't roll back a deployment, only deploy a fix.

## Checklist before opening the commit

- [ ] No behavior change (callers see same return/side-effects).
- [ ] No new `var` declarations that shadow globals.
- [ ] All new helpers are reachable / used (no dead exports).
- [ ] Magic values moved to `Constants.js` (or justified inline with a comment).
- [ ] `get_errors` clean on touched files.
- [ ] `prettier --check` passes.
- [ ] Commit message starts with `refactor:` and names the smell.
- [ ] Smoke test plan documented in commit body if behavior is even slightly user-visible.
