# Project inventory and server comparison

**Server (source of truth):** `178.128.27.125` → `/var/www/solana_agent`  
**Local project root:** `website/` (this directory)

---

## 1. Local project files (full inventory)

All files under `website/` excluding `node_modules/` and `.git/`:

| Path | Size (bytes) | Deployed by script? |
|------|--------------|---------------------|
| `api-server.cjs` | 52163 | Yes |
| `api.html` | 16768 | Yes |
| `openapi.json` | — | Yes |
| `mcp-server.cjs` | — | No (run locally / agent env) |
| `deploy-website-to-droplet.sh` | 4175 | No |
| `icon_dock.png` | 27357 | Yes |
| `index.html` | — | Yes |
| `asry.html` | — | Yes |
| `loading-animation.gif` | 229697 | Yes |
| `logo_btc_nb.png` | 101106 | Yes |
| `package-lock.json` | 77390 | No |
| `package.json` | 464 | Yes |
| `proof-of-reserves.html` | 67027 | Yes |
| `scripts/generate-btc-key.sh` | 642 | No |
| `scripts/generate-solana-key.sh` | 643 | No |
| `solanaagent_rec.png` | 52017 | Yes |
| `test-api-no-tx.js` | 5697 | No |
| `test-pages.js` | — | No |

**Total: 21+ files** (exclude `node_modules/` and `.git/`). `.DS_Store` and `.env` are gitignored.

---

## 2. Files the deploy script pushes to the server

From `deploy-website-to-droplet.sh` (SCP targets):

**Root of `/var/www/solana_agent/`:**
- `index.html`
- `asry.html`
- `proof-of-reserves.html`
- `api.html`
- `solanaagent_rec.png`
- `loading-animation.gif`
- `icon_dock.png`
- `logo_btc_nb.png`
- `api-server.cjs`
- `openapi.json`
- `package.json`

**Not deployed (local-only):**
- `deploy-website-to-droplet.sh`
- `package-lock.json`
- `scripts/*`
- `test-api-no-tx.js`
- `.DS_Store`

---

## 3. Comparing with the server (source of truth)

SSH to the server requires credentials (e.g. `.env` with `DROPLET_IP` and `DROPLET_SSH_PASSWORD`). Use the script:

```bash
./compare-and-sync-from-server.sh
```

This will:
1. List all files on the server at `/var/www/solana_agent`
2. Compare with the list above and report: only-on-server, only-local, and size differences
3. Optionally **pull from server → local** so local matches the source of truth (run with `PULL=1`)

See `compare-and-sync-from-server.sh` for usage.
