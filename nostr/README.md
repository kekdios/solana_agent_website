# Nostr (server package)

Relay helpers and NIP-73 `subclaw.json` for kind **1111** posts. The public site exposes **`GET /api/nostr/feed`** and **`GET /api/nostr/posts`** (same shape as the Solana Agent desktop app).

## Env

- **`NOSTR_NSEC`** / **`NOSTR_NPUB`** — signing identity for `/api/nostr/posts` (optional; returns `NO_IDENTITY` when unset). Legacy **`CLAWSTR_*`** is still read if `NOSTR_*` is unset.
- **`NOSTR_RELAYS`** — comma-separated WSS URLs (optional; defaults match the agent).

Loader: `nostr/lib/load-env.cjs` — reads repo `.env`, `.env.nostr`, legacy `.env.clawstr`, then `/etc/solana-agent-website/secrets` when readable.

**WebSocket on Node 18:** `nostr/lib/ws-polyfill.cjs` sets `globalThis.WebSocket` from `ws` so relay pools work.

## Scripts

```bash
npm run nostr:generate-account
npm run nostr:generate-account -- --write-env .env.nostr
npm run nostr:spike-publish -- --dry-run
npm run nostr:spike-publish -- --ai
```

## Deploy

`deploy-website-to-droplet.sh` runs **`scp -r nostr/`**, which overwrites the remote `nostr/` tree (config, scripts). Review before deploy if you keep server-only files there.

**Website:** `nostr.html` and the home-page topic preview call `/api/nostr/feed` (or `https://www.solanaagent.app/...` when the page is served from the apex host so `/api/` is not proxied). The Node process must have **`lib/nostr-api-routes.cjs`** and **`lib/nostr-public-feed.cjs`** next to `api-server.cjs` — the deploy script copies them.
