-- Additive-only schema: swap, arbitrage, tokens, listings, invoices.
-- DROPLET: Never use DROP TABLE, TRUNCATE, or destructive ALTER here. Updates only:
--   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS (safe to re-run)
--   - New columns: ALTER TABLE ... ADD COLUMN ... (use IF NOT EXISTS where supported)
-- Run check-schema-safe.sh before applying to the droplet. Create DB first if needed:
--   CREATE DATABASE solana_agent_website;
--   psql -U user -d solana_agent_website -f schema.sql
-- Set DATABASE_URL in env (e.g. postgresql://user:pass@localhost:5432/solana_agent_website).

CREATE TABLE IF NOT EXISTS swap_transactions (
  id SERIAL PRIMARY KEY,
  changenow_id VARCHAR(255) NOT NULL UNIQUE,
  sol_amount NUMERIC(24, 9) NOT NULL,
  btc_sats BIGINT,
  status VARCHAR(64) NOT NULL DEFAULT 'waiting',
  solana_signature VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS arbitrage_transactions (
  id SERIAL PRIMARY KEY,
  external_id VARCHAR(255),
  type VARCHAR(32),
  amount_sats BIGINT,
  amount_usd NUMERIC(18, 4),
  status VARCHAR(64) NOT NULL DEFAULT 'pending',
  signature VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swap_created ON swap_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arb_created ON arbitrage_transactions(created_at DESC);

-- Explorer: tokens created by agents (metadata only; mint_address if created on-chain elsewhere)
CREATE TABLE IF NOT EXISTS tokens (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  decimals SMALLINT NOT NULL DEFAULT 9,
  supply NUMERIC(36, 0) NOT NULL,
  description TEXT,
  revoke_freeze_authority BOOLEAN NOT NULL DEFAULT false,
  revoke_mint_authority BOOLEAN NOT NULL DEFAULT false,
  revoke_update_authority BOOLEAN NOT NULL DEFAULT false,
  metaplex_metadata BOOLEAN NOT NULL DEFAULT false,
  mint_address VARCHAR(64),
  creator_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listing requests: token listed after payment to treasury is confirmed
CREATE TABLE IF NOT EXISTS listing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  fee_sol NUMERIC(18, 9) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  payment_tx_signature VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE(token_id)
);

CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator_address);
CREATE INDEX IF NOT EXISTS idx_listing_requests_token ON listing_requests(token_id);
CREATE INDEX IF NOT EXISTS idx_listing_requests_status ON listing_requests(status);

-- Invoices: agent submits token details → we issue invoice (fee = estimated creation + 5%) → agent pays → we create token and list
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  decimals SMALLINT NOT NULL DEFAULT 9,
  supply NUMERIC(36, 0) NOT NULL,
  description TEXT,
  revoke_freeze_authority BOOLEAN NOT NULL DEFAULT false,
  revoke_mint_authority BOOLEAN NOT NULL DEFAULT false,
  revoke_update_authority BOOLEAN NOT NULL DEFAULT false,
  metaplex_metadata BOOLEAN NOT NULL DEFAULT false,
  creator_address VARCHAR(64),
  fee_sol NUMERIC(18, 9) NOT NULL,
  fee_lamports BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  payment_tx_signature VARCHAR(128),
  token_id INTEGER REFERENCES tokens(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at DESC);
