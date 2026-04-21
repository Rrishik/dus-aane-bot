# Contributing

Thanks for looking! This is a small, opinionated codebase. A few notes so your PR lands smoothly.

## Ground rules

- **Google Apps Script V8 only.** No modules, no `import`/`export`, no TypeScript. Everything is globals-on-the-same-runtime.
- **`var` over `const`/`let` at the top level.** Apps Script treats each `.js` file as a separate script and re-declaring a `const` in two files is a syntax error at load time. `var` silently redeclares. Inside functions, use whatever's clearest.
- **No build step.** What's in the repo is what ships. Don't add bundlers.
- **No external npm deps for runtime code.** The `scripts/` folder is gitignored and can use anything you like locally.

## Project layout (high level)

```
Code.js                 # Webhook / async trigger orchestration
Constants.js            # Categories, bank senders, column indexes
BotHandlers.js          # Telegram command + callback routers
TelegramUtils.js        # Telegram API wrappers, retry/backoff
TransactionProcessor.js # Email → LLM → Sheet pipeline
GoogleSheetUtils.js     # Sheet CRUD + merchant resolution tabs
Analytics.js            # /stats aggregations and formatters
AskTools.js             # /ask tool-calling definitions
AIProviders.js          # Azure OpenAI HTTP client
TenantRegistry.js       # Tenants tab CRUD
Onboarding.js           # /start, /register, /myinfo, activation
AdminHelpers.js         # Manually-run maintenance (create template, seed, etc.)
worker/                 # Cloudflare Worker proxy
```

See [../README.md](../README.md) for the runtime architecture.

## Local setup

```powershell
npm install
# Log in to the bot's Google account
npx clasp login
# Pull the current project or create one — see README admin steps
```

You'll also need a local `AConfig.js` (gitignored) with all the constants listed in the README. CI generates this from GitHub secrets; for local dev, just create it.

## Running & deploying locally

- `npx clasp push --force` — push local files to Apps Script.
- Open the script editor → run functions manually (e.g. `triggerEmailProcessing`, `adminCreateTemplateSheet`).
- CI runs on push to `main`; avoid force-pushing directly.

## Formatting

```powershell
npx prettier --write .
```

Runs pre-commit via CI too. Please keep it clean.

## Adding a new bank

The narrowest change: add verified transaction-alert senders to `TRANSACTION_SENDERS` in [Constants.js](Constants.js). Also:

- Add the bank's domain to `BANK_FROM_DOMAINS` if it's not covered.
- Add any known marketing/statement addresses for that bank to `IGNORE_SENDERS`.
- Regenerate the user-facing Gmail filter (the bot sends the fresh query on `/register`, so existing tenants can re-paste if they want new banks covered).

Test with a real forwarded email if possible — LLM extraction varies wildly by formatting.

## Adding a new command

1. Add the handler to `BotHandlers.js` (`switch` in `handleMessage`).
2. If it's an onboarding command, add it to the `ONBOARDING` allowlist array too.
3. Add an entry to `setTelegramCommands()` in `TelegramUtils.js` (and manually run that function once in the script editor to register it with Telegram).
4. Document it in `README.md`.

## Adding a new `/ask` tool

1. Append a tool definition to `ASK_TOOLS` in `AskTools.js`.
2. Implement it in `executeAskTool`.
3. If it needs aggregation helpers, put them in `Analytics.js`.

Keep tool inputs simple (flat JSON). The LLM is better at short parameter lists.

## Parse modes — read before touching Telegram copy

This codebase uses **legacy `Markdown`** (not `MarkdownV2`) almost everywhere. That's deliberate:

- MarkdownV2 requires escaping `.`, `-`, `(`, `)`, `!`, `+`, `=`, etc. — which means every email address, date, and `➡️` emoji-adjacent text needs escaping.
- Legacy `Markdown` only requires escaping `_`, `*`, backticks — much saner for our messages that contain `user@gmail.com` and `₹1,234.56`.

Rules:

- Use `escapeMarkdown()` (defined in `TelegramUtils.js`) for any user-supplied text (merchant, username) before concatenating into a message.
- Keep `parse_mode: "Markdown"` consistent in a single message.
- If you must use `MarkdownV2`, do it for the whole message and escape every literal special char.

## Tenant context

Every entry point that touches sheets or sends Telegram messages must be tenant-aware:

- **`extractTransactions`** — sets `setCurrentTenant(tenant)` per-message based on the forwarder's email.
- **`doPost`** — sets tenant from the incoming Telegram `chat_id`.
- **Async triggers (`continueBackfill`, `processWebhookUpdate`)** — restore tenant from a stashed `chat_id` or `sheet_id` in `PropertiesService`.

Never call `getSpreadsheet()` or `sendTelegramMessage(CHAT_ID, ...)` in a code path that could be shared between tenants. Use `getTenantSheetId()` and `getTenantChatId()` accessors.

## Security checklist for PRs

- Don't commit `AConfig.js` or any `.env`. Double-check with `git diff` before pushing.
- Don't log full email bodies or Azure keys. It's fine to log message ids, chat ids, tenant names.
- Don't bypass `shouldIgnoreMessage` / `isFromAllowedBank` in the happy path — these are the defense-in-depth layer when users misconfigure their Gmail filter.
- Validate `chat_id` ownership before mutating any tenant data — don't trust `chat_id` parameters from callback payloads; re-look up the tenant from the incoming update.
- Avoid regex DoS — anchor patterns, don't build regex from user input.

## Debugging tips

- Apps Script → **Executions** tab shows logs for every run including triggers. Search by function name.
- `console.error` and `console.warn` surface as severity levels in Stackdriver / Executions.
- For local-ish debugging of parsing, paste a raw email body into a scratch function in the script editor and run it directly.
- Test webhook flow: `POST` a Telegram-shaped JSON payload at the `/exec` URL with `curl` or a REST client.

## Pull request checklist

- [ ] `prettier --write` clean
- [ ] No secrets / tokens / personal email addresses in the diff
- [ ] Updated `README.md` / `PRIVACY.md` if behavior changes
- [ ] Verified tenant isolation (no new hard-coded `SHEET_ID` / `CHAT_ID` usage without a fallback through `getTenantSheetId` / `getTenantChatId`)
- [ ] Manual smoke test of the affected flow (command, callback, email processing, `/backfill`, etc.)

Thanks!
