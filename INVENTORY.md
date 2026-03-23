# Project inventory

**Authoritative deploy list:** `deploy-website-to-droplet.sh` — it defines exactly what is copied to `/var/www/solana_agent` on the droplet. This file is not a live byte inventory of the server.

## Entry points

| Component | Path / command |
|-----------|----------------|
| HTTP API | `api-server.cjs` — `npm start` (port `API_PORT` or **3001**) |
| MCP server | `mcp-server.cjs` — `npm run mcp` (stdio; **swap + reserves** tools only) |
| Clawstr HTTP | `clawstr/mount.cjs` (mounted from `api-server.cjs`) |
| Bulletin HTTP | `clawstr/bulletin-mount.cjs` (mounted from `api-server.cjs`) |
| Deploy + API restart | `./deploy-website-to-droplet.sh` (expects `.env` with `DROPLET_IP`, `DROPLET_SSH_PASSWORD`) |
| Smoke tests | `npm test` → `test-api-no-tx.js` + `test-pages.js` |

## Deploy notes

- **`api-server.cjs`**, `package.json`, and `package-lock.json` go to the **site root** (`/var/www/solana_agent/`), not under `data/`.
- **`data/.gitkeep`** is copied to `/var/www/solana_agent/data/`; visitor log is **`data/site-visitors.jsonl`** (gitignored).
- **`scripts/ensure-analytics-data-dir.sh`** runs on deploy before `systemctl restart solana-agent-website-api`.
- **`scp -r clawstr/`** replaces the entire remote **`clawstr/`** tree, including **`bulletin.sqlite`**, **`bulletin.sqlite-wal`**, etc. Avoid deploying from a dev machine whose local bulletin DB would overwrite production unintentionally.

## Optional: compare with server

`compare-and-sync-from-server.sh` — see the script’s comments for SSH usage and `PULL=1`.

## Documentation map

| Document | Role |
|----------|------|
| `README.md` | Run locally, deploy, features at a glance |
| `api.html` | **Full** human-readable list of JSON HTTP routes (kept in sync with `api-server.cjs` when changing the API) |
| `openapi.json` | **Partial** OpenAPI 3 schema (swap subset, reserves, bulletin, clawstr, analytics, ASRY claim — not every route) |
| `clawstr/README.md` | Clawstr keys, relays, bulletin env vars, spike publish |
| `systemd/README.md` | Treasury mint **timer** unit install |
| `lib/asry/README.md` | Treasury receive / USDT↔USDC scripts |
| `docs/*.md` | Architecture / product plans; may lag code — see status notes inside |
