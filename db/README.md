# Postgres database for swap and arbitrage transactions

One-time setup to store SOL→BTC swap history, arbitrage transactions, tokens, and listing/invoice data. The two main agent-facing flows are **swap** (SOL→BTC via LI.FI) and **token creation** (invoices: submit details → pay fee → server creates SPL token and lists). The **droplet** has Postgres and secrets configured under `/etc/solana-agent-website/secrets`; for **local** development you can run Postgres on your machine and point the API at it.

> **Note (how Postgres is structured):**  
> PostgreSQL runs as a single server process with **one data directory** on your machine (chosen when you run `initdb` or install via Homebrew). Inside that server you create **many databases** (one of them is `solana_agent_website`). The files under `website/db/` are just schema and helper scripts; they do **not** contain the actual database files like SQLite would. The app connects into the running Postgres server using `DATABASE_URL` and talks to the `solana_agent_website` database inside it.

---

## Droplet: updates only (never overwrite data)

**The droplet database must never be overwritten.** Only additive changes are allowed:

- **Allowed:** `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN ...` (new tables, new indexes, new columns). Re-running `schema.sql` with these is safe and does not remove data.
- **Forbidden in schema.sql:** `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or any statement that deletes data or tables.

Before deploying schema changes, run the safety check (from `website/`):

```bash
./db/check-schema-safe.sh
```

If it exits 0, the schema file is safe to apply. The droplet deploy script (`remote-setup-postgres.sh`) also refuses to apply `schema.sql` if it contains `DROP` or `TRUNCATE`, so the droplet will never receive destructive DDL from a normal deploy.

---

## Droplet: automatic backups (where they are kept)

Before applying any schema change, the droplet runs an automatic **full DB backup** via `pg_dump`.

- **Location on the droplet:** `/var/backups/solana_agent_website/`
- **Filename pattern:** `pre-schema_YYYYMMDD_HHMMSS.sql` (one file per schema apply).
- **Retention:** The script keeps the **last 20** backups; older files are removed automatically.
- **Restore (on droplet):**  
  `sudo -u postgres psql -d solana_agent_website -f /var/backups/solana_agent_website/pre-schema_YYYYMMDD_HHMMSS.sql`  
  (only if you need to roll back; normally the additive schema does not require restore.)

To use a different backup directory, pass it as the second argument when running the remote setup script (e.g. `./remote-setup-postgres.sh /var/www/solana_agent /root/backups/solana_agent_website`).

---

## Droplet secrets (`/etc/solana-agent-website/secrets`)

On the server, the website API reads env vars from this file. The systemd service (or run script) sources it. Required and optional variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `BTC_PRIVATE_KEY_WIF` | Yes (for reserves/swap) | Bitcoin WIF key for the reserve address |
| `SOLANA_PRIVATE_KEY` | Yes (for reserves/swap) | Base58 Solana keypair for the reserve |
| `TREASURY_SOLANA_ADDRESS` | Yes (for invoices/listings) | SOL address that receives invoice/listing fees |
| `CHANGENOW_API_KEY` | No (deprecated) | Not used; SOL→BTC swap uses LI.FI (no key required). |
| `DATABASE_URL` | Yes (for persistence) | Postgres connection string, e.g. `postgresql://user:pass@localhost:5432/solana_agent_website` |
| `SOLANA_RPC_URL` | No | RPC URL (default: `https://api.mainnet-beta.solana.com`) |
| `ABSR_MINT_ADDRESS` | No | ABSR token mint (default: BvtyqwRSgrKjX3jUfR7Sq5XmuVKrPEcSTDbLmTCstP1E) |
| `ABSR_BTC_RESERVE_ADDRESS` | No | Override BTC reserve address for daily mint (default: derived from `BTC_PRIVATE_KEY_WIF`) |
| `MIN_SOL_FOR_MINT_LAMPORTS` | No | Min SOL (lamports) signer must have before mint (default: 15000 ≈ 0.000015 SOL) |

**Format:** one `KEY=value` per line, no spaces around `=`. No quotes unless the value contains spaces. Restrict permissions: `chmod 600 /etc/solana-agent-website/secrets`.

**SOL→BTC swap (LI.FI):**  
Only SOL→BTC is supported, via [LI.FI](https://docs.li.fi/agents/overview) at `https://li.quest/v1`. The server gets a quote, signs the Solana transaction, submits it, and tracks status by tx hash. **Bitcoin settlement can take several minutes to a few hours** depending on network congestion. No API key required (200 req/2h); optional key at [li.fi](https://li.fi) for higher limits. The Proof of Reserves page does **not** expose a swap form or min/balance to visitors; reserve SOL cannot be swapped from the public site. Swaps are triggered only via the API (e.g. by authorized agents or scripts).

---

## ABSR token (created on the droplet)

**Agent Bitcoin Strategic Reserve (ABSR)** is the on-chain token backing the Bitcoin reserve; 1 satoshi in the reserve = 1 ABSR.

| Property | Value |
|----------|--------|
| Name | Agent Bitcoin Strategic Reserve |
| Symbol | ABSR |
| Decimals | 0 |
| Initial supply | 10,000 (minted to treasury) |
| Description | 1 satoshi - 1 ABSR (in Metaplex metadata) |
| Metaplex | Metadata created (data URI) |
| Revoke freeze / mint / update | All false (authorities stay with treasury/signer) |
| Creator | Treasury/signer address |

**On-chain details**

| Item | Value |
|------|--------|
| ABSR mint address | `BvtyqwRSgrKjX3jUfR7Sq5XmuVKrPEcSTDbLmTCstP1E` |
| Treasury (creator) ATA | `AroLLvUThb9cgNTRF722kP91xse6aWr5ZLggTEbGGu7q` |
| Metaplex metadata tx | `2ZXUkzJ7jHDGgXE6ymmipQnnqWTk3f9tGhESgrvcCfNfMejAbg5v3sF7Xf8tmdESA9TScw58dRsr85j7rYQv5qD1` |

**Minting costs (SOL)**  
Yes. Each mint transaction pays Solana network fees (the treasury/signer is the fee payer). There is no separate “mint” fee—only the normal transaction cost.

| Component | Estimated cost |
|-----------|-----------------|
| Base fee (per signature) | 5,000 lamports (0.000005 SOL) |
| Typical daily mint tx (1 signature) | ~0.000005–0.00001 SOL |
| With priority fee (faster inclusion) | ~0.00001–0.00005 SOL |

So one daily ABSR mint run is on the order of **0.00001 SOL** in normal conditions. The mint script checks that the signer (fee-payer) wallet has at least **0.000015 SOL** (or `MIN_SOL_FOR_MINT_LAMPORTS` if set) before attempting a mint; if not, it exits without sending a transaction.

---

## Local development (Postgres on your machine)

1. **Install Postgres** (if needed):
   - macOS: `brew install postgresql@16` then `brew services start postgresql@16`
   - Or use Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`

2. **Create DB and apply schema** (from `website/` or repo root):
   ```bash
   ./db/setup-local.sh
   ```

3. **Set `DATABASE_URL` in `.env`** in the `website/` directory (same file used by the deploy/compare scripts):
   ```bash
   DATABASE_URL=postgresql://$(whoami)@localhost:5432/solana_agent_website
   ```
   If your local Postgres uses a password: `postgresql://user:password@localhost:5432/solana_agent_website`

4. Run the API locally (e.g. `node api-server.cjs`). Without `DATABASE_URL`, the API still runs but swap/arbitrage/tokens/listing data is not persisted.

---

## Server / droplet (manual steps if not using deploy script)

### 1. Create database (as postgres superuser)

```bash
sudo -u postgres psql -c "CREATE DATABASE solana_agent_website;"
```

### 2. Create user and grant access (optional)

```bash
sudo -u postgres psql -c "CREATE USER solana_agent_website WITH PASSWORD 'your_password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE solana_agent_website TO solana_agent_website;"
```

### 3. Run schema (additive only)

```bash
./db/check-schema-safe.sh   # optional: verify no DROP/TRUNCATE
psql -U postgres -d solana_agent_website -f db/schema.sql
# Or with the user you created:
psql -U solana_agent_website -d solana_agent_website -f db/schema.sql
```

### 4. Set DATABASE_URL

Add to `/etc/solana-agent-website/secrets` (or your API env):

```
DATABASE_URL=postgresql://solana_agent_website:your_password@localhost:5432/solana_agent_website
```

Then restart the website API service. If `DATABASE_URL` is not set, the API still runs but swap/arbitrage history is not persisted and the Exchanges/Arbitrage tabs will show empty tables.

---

## Daily ABSR reserve sync (once per day)

ABSR is pegged 1:1 to the Bitcoin reserve: **one ABSR = one satoshi** in the reserve address. The reserve address is the one shown on the Bitcoin / proof-of-reserves page (derived from `BTC_PRIVATE_KEY_WIF`, or override with `ABSR_BTC_RESERVE_ADDRESS`).

**Job:** Once per day, compare the BTC balance (in sats) of the reserve address to the on-chain ABSR token supply. If the reserve has more sats than current ABSR supply, mint the difference to the treasury so that **ABSR supply = reserve sats**. No ABSR exists without a corresponding satoshi in the reserve.

**Scripts (in `website/`):**

- `mint-absr-to-reserve.cjs` — Fetches reserve BTC balance (Blockstream), reads ABSR supply from Solana, mints any shortfall to `TREASURY_SOLANA_ADDRESS`. Requires same env as API (see Droplet secrets); optional `ABSR_MINT_ADDRESS` (default: BvtyqwRSgrKjX3jUfR7Sq5XmuVKrPEcSTDbLmTCstP1E).
- `run-daily-absr-mint.sh` — Sources env from `/etc/solana-agent-website/secrets` (or `.env` locally) and runs the script.

**Schedule on the droplet (choose one):**

**Cron (run at 02:00 every day):**

```bash
# As root or the user that owns the app, ensure script is executable:
chmod +x /var/www/solana_agent/run-daily-absr-mint.sh
# Add to crontab -e:
0 2 * * * /var/www/solana_agent/run-daily-absr-mint.sh >> /var/log/absr-mint.log 2>&1
```

**Systemd timer (run once per day):**

Copy the example unit and timer from `agent/deploy/` to the droplet (e.g. into `/etc/systemd/system/`), edit paths if needed, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now daily-absr-mint.timer
```

See `agent/deploy/daily-absr-mint.service.example` and `daily-absr-mint.timer.example`.

---

## Test arbitrage transactions on the droplet

**From your Mac (no SSH):** Check that the live API returns ABSR transactions (most recent first):

```bash
curl -s "https://www.solanaagent.app/api/arbitrage/transactions"
```

You get `{"transactions":[...]}`. If the list is empty, the droplet DB may have no rows yet (mint or swap events add them).

**On the droplet (SSH):** To confirm the DB has the table and the API reads it:

1. **Count rows in the DB** (uses `DATABASE_URL` from secrets; adjust if your connection string differs):
   ```bash
   ssh root@YOUR_DROPLET_IP
   source /etc/solana-agent-website/secrets 2>/dev/null
   psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM arbitrage_transactions;"
   ```

2. **Hit the API from the droplet** (same as the website, but from localhost):
   ```bash
   curl -s "http://127.0.0.1:3001/api/arbitrage/transactions"
   ```
   (If the API runs on a different port, use that port; check the systemd service or how the API is started.)

3. **Add a test row and see it in the API** (optional): Run the mint script in test mode with a tiny amount so it inserts a row and optionally mints 1 ABSR; then re-run the curl above to see the new row:
   ```bash
   cd /var/www/solana_agent
   source /etc/solana-agent-website/secrets
   TEST_MINT_ABSR=1 ./run-daily-absr-mint.sh
   curl -s "http://127.0.0.1:3001/api/arbitrage/transactions"
   ```

---

### Deploy or check DB on the droplet

From the repo root (with `.env` containing `DROPLET_IP` and `DROPLET_SSH_PASSWORD`):

```bash
./deploy/check-and-deploy-db-on-droplet.sh
```

This checks on the droplet for: Postgres installed, database `solana_agent_website` exists, schema applied (e.g. `tokens` table), and `DATABASE_URL` in `/etc/solana-agent-website/secrets`. If anything is missing, it runs the one-time Postgres setup and sets `DATABASE_URL`, then restarts the API.
