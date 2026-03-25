# Solana Agent Website

Website and API for [Solana Agent](https://www.solanaagent.app): proof of reserves and SOL→BTC swap.

## What this repo is

- **Static site:** `index.html`, `treasury.html` (SAUSD + **SAUSD/USDC** Orca panel + mint schedule), `sabtc.html`, `saeth.html`, `asry.html`, `reserves-bitcoin.html`, `reserves-absr.html`, `reserves-solana.html`, `reserves-declaration.html`, `proof-of-reserves.html`, `api.html`, `nostr.html`, `visitors.html` (pageview stats). `saeth-sausd.html` redirects to `saeth.html`.
- **HTTP API:** `api-server.cjs` — reserves & proof, Bitcoin/Solana **transaction lists**, **explorer/treasury**, **arbitrage summary**, swap (SOL→BTC via LI.FI), **ASRY** (`/api/asry-info`, `/api/asry/transactions`, `POST /api/asry/claim-from-deposit`), **treasury-token** (`/api/treasury-token/{sabtc|sausd|saeth}/{info|transactions}`), **token-supply**, **reserves/solana-address**, **Orca Whirlpool proxy** (`GET /api/orca/pool/{address}`): returns Orca JSON when indexed; **full on-chain Whirlpool decode** when Orca returns no usable pool JSON (`lib/orca-whirlpool-onchain.cjs`); when Orca JSON exists but **both** `tokenBalanceA` and `tokenBalanceB` are zero, **SPL vault balances** are filled from Solana RPC (`vault_balances_source: "solana_rpc"`). **Analytics:** `POST /api/analytics/pageview`, `GET /api/analytics/stats`. **Nostr:** `GET /api/nostr/feed`, `GET /api/nostr/posts`. Served at `/api/` (e.g. behind nginx). **Orca pool env overrides:** `SABTC_ORCA_POOL_ADDRESS`, `SAETH_SAUSD_ORCA_POOL_ADDRESS`, `SAUSD_USDC_ORCA_POOL_ADDRESS` (defaults match `sabtc.html` / `saeth.html` / `treasury.html`). **Visitor log:** `VISITOR_LOG_PATH` (default `data/site-visitors.jsonl`). Nostr secrets: see `nostr/README.md`.
- **OpenAPI:** `GET /api/openapi.json` — **partial** schema (swap, reserves subset, nostr, analytics, ASRY claim). For every JSON route, see **`api.html`** (and `api-server.cjs`).
- **MCP server:** `mcp-server.cjs` — [Model Context Protocol](https://modelcontextprotocol.io) with **`get_reserves`** and **swap** tools only (`swap_min`, `swap_estimate`, `swap_create`, `swap_status`). Run `npm run mcp`. No Nostr/analytics tools in MCP.

## Agent flow

**Swap SOL → BTC** — `GET /api/swap/min`, `GET /api/swap/estimate?amountSol=X`, `POST /api/swap/create`. Poll `GET /api/swap/status/:id` optionally.

**Visitors / analytics:** If `visitors.html` shows no data, check that `POST /api/analytics/pageview` is not returning `ANALYTICS_WRITE_FAILED` (usually the API user cannot write `data/site-visitors.jsonl`). On the droplet: `bash /var/www/solana_agent/scripts/ensure-analytics-data-dir.sh /var/www/solana_agent` (also run automatically by `deploy-website-to-droplet.sh`).

## Run locally

```bash
npm install
npm start
```

API runs on port 3001 (or `API_PORT`). Set `BTC_PRIVATE_KEY_WIF`, `SOLANA_PRIVATE_KEY`, `TREASURY_SOLANA_ADDRESS` for full functionality.

**Treasury mint schedule:** `treasury-mint-schedule.json` drives both the Treasury page copy and `scripts/mint-treasury-sabtc-saeth-scheduled.cjs`. On the server, install `systemd/solana-agent-treasury-mint.timer` (see `systemd/README.md`). Local dry run: `npm run treasury:mint-scheduled`.

## Deploy to droplet

From this directory:

```bash
# .env with DROPLET_IP, DROPLET_SSH_PASSWORD (optional: REMOTE_USER, CERTBOT_EMAIL)
./deploy-website-to-droplet.sh
```

What the script does (high level):

- **`scp`** static HTML/JS/assets, `api-server.cjs`, `openapi.json`, `package.json` / lockfile, `lib/asry/`, **`lib/nostr-api-routes.cjs`**, **`lib/nostr-public-feed.cjs`**, Orca helpers, `nostr/`, scripts, and **`systemd/solana-agent-website-api.service`** (plus treasury mint units).
- On the server: installs the API unit to `/etc/systemd/system/`, **`daemon-reload`**, **`enable`**, **`npm install --omit=dev`**, **`restart solana-agent-website-api`**, then **`curl`** to `http://127.0.0.1:3001/api/reserves` to verify the process is up.

**Restart API only (no full file sync):** `./restart-droplet-api.sh`

**If `/api/*` returns 502 / HTML in the browser**

1. On the droplet: `journalctl -u solana-agent-website-api -n 80 --no-pager` (look for `MODULE_NOT_FOUND` or crash loops).
2. Confirm **`/var/www/solana_agent/lib/nostr-api-routes.cjs`** and **`nostr-public-feed.cjs`** exist (required for Nostr routes).
3. Confirm nginx proxies **`/api/`** to **`127.0.0.1:3001`** (see `systemd/README.md`).
4. **Nostr pages:** use **`https://www.solanaagent.app`** (apex without `www` may not proxy `/api/` the same way); `nostr.html` falls back to the `www` API when needed.

See **`INVENTORY.md`** and **`systemd/README.md`** for file layout and units. Longer product/backend plans live under **`docs/`** (see **`docs/README.md`**).

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run API server |
| `npm run mcp` | Run MCP server (stdio; reserves + swap tools) |
| `npm test` | API smoke (`test-api-no-tx.js`) + HTML checks (`test-pages.js`) |
| `npm run test:api` | API smoke only |
| `npm run test:pages` | HTML checks only |
| `npm run test:swap` / `npm run test:lifi` | On-chain / LI.FI swap tests (use with care) |
| `npm run treasury:mint-scheduled` | Dry-run or run scheduled SABTC/SAETH mints (see `systemd/README.md`) |
| `npm run nostr:generate-account` / `nostr:spike-publish` | Nostr keys + test publish |
| `npm run treasury:receive` / `treasury:receive-reward` / `treasury:swap-*` | Treasury ops (see `lib/asry/README.md`) |

## GitHub

This project is a Git repository. To push to GitHub:

1. **Create a new repository** on [GitHub](https://github.com/new) (do not add a README or .gitignore; the repo already has them).

2. **Add the remote and push:**
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git branch -M main
   git push -u origin main
   ```

   Or with SSH: `git remote add origin git@github.com:YOUR_USERNAME/YOUR_REPO_NAME.git`

3. **Or use GitHub CLI** (if installed): `gh repo create YOUR_REPO_NAME --private --source=. --push`

## License

MIT
