# Solana Agent Website

Website and API for [Solana Agent](https://www.solanaagent.app): proof of reserves, SOL→BTC swap, and token creation.

## What this repo is

- **Static site:** `index.html`, `proof-of-reserves.html`, `explorer.html`, `api.html` — reserves, Token Explorer, API reference.
- **HTTP API:** `api-server.cjs` — reserves, proof, swap (SOL→BTC via LI.FI), invoices (token creation), tokens/listings. Served at `/api/` (e.g. behind nginx).
- **OpenAPI:** `GET /api/openapi.json` — machine-readable schema for agents.
- **MCP server:** `mcp-server.cjs` — [Model Context Protocol](https://modelcontextprotocol.io) tools for the same flows (run with `npm run mcp`).

## Two main agent flows

1. **Swap SOL → BTC** — `GET /api/swap/min`, `GET /api/swap/estimate?amountSol=X`, `POST /api/swap/create`. Poll `GET /api/swap/status/:id` optionally.
2. **Create token** — `POST /api/invoices` (get invoice) → pay SOL to treasury → `POST /api/invoices/confirm` with `invoice_id` and `tx_signature`.

See [API reference](api.html) and the OpenAPI spec for details.

## Run locally

```bash
npm install
npm start
```

API runs on port 3001 (or `API_PORT`). Set `DATABASE_URL`, `BTC_PRIVATE_KEY_WIF`, `SOLANA_PRIVATE_KEY`, `TREASURY_SOLANA_ADDRESS` for full functionality (see `db/README.md`).

## Deploy to droplet

From this directory:

```bash
# .env with DROPLET_IP, DROPLET_SSH_PASSWORD
./deploy-website-to-droplet.sh
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run API server |
| `npm run mcp` | Run MCP server (stdio) |
| `npm test` | Run API + page tests |
| `npm run test:lifi` | Test SOL→BTC swap (small amount) |

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
