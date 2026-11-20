# AGENTS.md

## Commands
- Install: `npm install`
- Run tests: `node bot.test.js` (uses built-in `node:test`; no test script in package.json)
- Start apps via PM2: `pm2 start ecosystem.config.js` (apps: `bot`, `dashboard`, `scheduler`)
- Start individually: `node bot.js`, `node dashboard.js`, `node scheduler.js`
- WhatsApp pairing: `node collector.js login` (scan QR), then `node collector.js tarik` (pull history)
- No lint, typecheck, or build scripts exist.

## Environment
- Required `.env`: `GEMINI_API_KEY`, `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`; optional `BOT_TIMEZONE` (default `Asia/Jakarta`), `WA_COLLECT_SECONDS` (default `60`)
- `.env`, `db/*.db*`, `wa-auth/`, `wa-auth-backup-*`, `node_modules/` are gitignored
- `opencode.json` maps model to `google/gemini-2.0-flash` with google + groq providers reading `GEMINI_API_KEY` / `GROQ_API_KEY` from env

## Architecture / entrypoints
- `bot.js` — Telegraf Telegram bot (exports `createBot(memory, llm, analyzer)`; runs when `require.main === module`)
- `collector.js` — Baileys WhatsApp collector; modes `login` | `tarik`; stores into SQLite
- `dashboard.js` — Express API on `127.0.0.1:3000`, read-only DB (`readonly: true`)
- `scheduler.js` — node-cron runs `node collector.js tarik` at 08:00, 13:00, 20:00
- `memory.js` — SQLite schema + FTS5 search; exports `openMemory`, `tokens`, `TAGS` (`hr`, `klien`, `pribadi`, `promo`)
- `llm.js` — `ask` / `askJson` with Gemini primary, Groq fallback; `buildPrompt`
- `analysis.js` — `analyzeMessage` returns structured JSON (category/stage/method/status/confidence)

## Gotchas
- Bot only responds to the owner. First run generates a `claim` code; owner claims via Telegram `/pasang <kode>`. Tests stub `Telegram.prototype.callApi` and set `bot.botInfo`.
- Tests write to a temp DB copy; do not run against `db/data.db`.
- Dashboard DB is opened `readonly` — it will not write.
- Collector uses a lock file `wa-auth/.collector.lock`; concurrent `login`/`tarik` runs are blocked.
- `commonjs` module type (`"type": "commonjs"` in package.json) — use `require`, not ESM imports.
- `better-sqlite3` is a native module; `allowScripts` in package.json permits install scripts for baileys/protobufjs/better-sqlite3.
