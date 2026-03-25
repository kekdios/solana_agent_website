# Documentation index

Internal plans and policy notes for the Solana Agent **website** repo. **Live behavior** is defined by `api-server.cjs`, `openapi.json` (partial), and **`api.html`** (full HTTP surface).

| Document | Purpose |
|----------|---------|
| [HYPERLIQUID_TREASURY_SYNC_PLAN.md](./HYPERLIQUID_TREASURY_SYNC_PLAN.md) | Backend daemon design for Hyperliquid-aligned treasury sync (planning). |
| [ASRY-DEVELOPMENT-PLAN.md](./ASRY-DEVELOPMENT-PLAN.md) | ASRY delivery phases and build order vs current `api-server.cjs` / `lib/asry/`. |
| [ASRY-TREASURY-AND-YIELD-PLAN.md](./ASRY-TREASURY-AND-YIELD-PLAN.md) | ASRY policy draft; compare to **`GET /api/asry-info`** on production. |

**Operations (not in this folder):** `README.md` (root), `INVENTORY.md`, `systemd/README.md`, `nostr/README.md`, `deploy-website-to-droplet.sh`.

*Last reviewed: March 2026.*
