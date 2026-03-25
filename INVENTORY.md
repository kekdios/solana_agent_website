# Project inventory

**Authoritative deploy list:** `deploy-website-to-droplet.sh` — it defines exactly what is copied to `/var/www/solana_agent` on the droplet. This file is not a live byte inventory of the server.

## Entry points

| Component | Path / command |
|-----------|----------------|
| HTTP API | `api-server.cjs` — `npm start` (port `API_PORT` or **3001**); production: **`solana-agent-website-api`** systemd unit |
| MCP server | `mcp-server.cjs` — `npm run mcp` (stdio; **swap + reserves** tools only) |
| Nostr HTTP | `lib/nostr-api-routes.cjs` + **`lib/nostr-public-feed.cjs`** (mounted from `api-server.cjs`) |
| Systemd (API) | `systemd/solana-agent-website-api.service` — copied by deploy to `/etc/systemd/system/` |
| Deploy + API restart | `./deploy-website-to-droplet.sh` (expects `.env` with `DROPLET_IP`, `DROPLET_SSH_PASSWORD`); **`./restart-droplet-api.sh`** for restart-only |
| Smoke tests | `npm test` → `test-api-no-tx.js` + `test-pages.js` |

## Deploy notes

- **`api-server.cjs`**, `package.json`, and `package-lock.json` go to the **site root** (`/var/www/solana_agent/`), not under `data/`.
- **`lib/nostr-api-routes.cjs`** and **`lib/nostr-public-feed.cjs`** are required for `/api/nostr/*`; `deploy-website-to-droplet.sh` copies them with the other `lib/` modules.
- **`data/.gitkeep`** is copied to `/var/www/solana_agent/data/`; visitor log is **`data/site-visitors.jsonl`** (gitignored).
- **`scripts/ensure-analytics-data-dir.sh`** runs on deploy before `systemctl restart solana-agent-website-api`.
- Deploy verifies the API with **`curl http://127.0.0.1:3001/api/reserves`** after restart (fails the SSH step if the process is down).
- **`scp -r nostr/`** replaces the entire remote **`nostr/`** tree (relays config, `subclaw.json`, scripts). Review before deploy if you rely on server-only files in that folder.

## Optional: compare with server

`compare-and-sync-from-server.sh` — see the script’s comments for SSH usage and `PULL=1`.

## Documentation map

| Document | Role |
|----------|------|
| `README.md` | Run locally, deploy, features at a glance |
| `api.html` | **Full** human-readable list of JSON HTTP routes (kept in sync with `api-server.cjs` when changing the API) |
| `openapi.json` | **Partial** OpenAPI 3 schema (swap subset, reserves, nostr, analytics, ASRY claim — not every route) |
| `nostr/README.md` | Nostr keys, relays, spike publish |
| `systemd/README.md` | **Website API** unit (`solana-agent-website-api`) + treasury mint **timer** |
| `docs/README.md` | Index of planning docs in `docs/` |
| `lib/asry/README.md` | Treasury receive / USDT↔USDC scripts |
| `docs/*.md` | Architecture / product plans; may lag code — see status notes inside |
