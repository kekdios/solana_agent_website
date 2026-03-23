# Hyperliquid Treasury Sync Bot Plan

Status: Planning document only (no runtime behavior changes in this doc).

Owner scope: website backend (`api-server.cjs` ecosystem) and treasury scripts.

## 1) Objective

Build a backend daemon/worker that keeps treasury reference prices and optional hedge/rebalance actions aligned with Hyperliquid data, starting with:

- `SABTC`
- `SAETH`

And designed to support additional treasury assets later (e.g., SAUSD, future symbols).

Primary goals:

- Run independently of chat/session heartbeats.
- Use one policy engine and one kill switch.
- Reduce Solana RPC cost through batching, caching, subscriptions, and precomputation.
- Persist decisions and execution outcomes for auditability.
- Expose read APIs for site/agents.

## 2) Why backend daemon (vs chat heartbeats)

- Closer to execution path (existing wallet + Orca integration already live).
- Always-on scheduling and deterministic intervals.
- Centralized risk controls and approvals.
- Shared RPC/index data layer reduces duplicated calls.
- Better observability: structured logs, alerts, post-trade verification.

## 3) High-level architecture

1. **Scheduler loop**
   - Interval-driven (e.g. every 5-15s market read loop, every 30-120s decision loop).
   - Jitter to avoid synchronized bursts.

2. **Market data layer**
   - Hyperliquid mid/fair prices for BTC, ETH (later additional symbols).
   - Orca pool state for SABTC/SAUSD and SAETH/SAUSD.
   - Treasury balances/positions.

3. **Policy engine**
   - Computes deviation, target bands, and recommended action.
   - Applies risk/cap constraints before any execution attempt.

4. **Execution layer**
   - Phase 1: dry-run only.
   - Phase 2: optional human approval.
   - Phase 3: autonomous live execution if policy + safety pass.

5. **State + observability**
   - Persist decisions, approvals, execution attempts, tx signatures, retries, and errors.
   - Emit health/status endpoint for UI + agents.

## 4) Data model (minimum)

Create a small SQLite store (or separate tables in existing DB) for:

- `sync_runs`
  - `id`, `started_at`, `finished_at`, `mode` (`dry_run|live`), `status`, `error`
- `market_snapshots`
  - `run_id`, `symbol`, `hyperliquid_price`, `orca_price`, `deviation_bps`, `raw_payload_ref`
- `policy_decisions`
  - `run_id`, `asset`, `action` (`hold|rebalance_buy|rebalance_sell`), `reason`, `size_quote`, `size_base`
  - guardrail fields: `max_trade_check`, `daily_cap_check`, `cooldown_check`, `slippage_check`, `liquidity_check`
- `execution_attempts`
  - `decision_id`, `attempt_no`, `status`, `tx_signature`, `slippage_realized_bps`, `failure_reason`
- `kill_switch_events`
  - `at`, `actor`, `state`, `reason`

## 5) Policy engine (v1)

Inputs:

- Hyperliquid reference price (mid).
- Orca implied spot for pool(s).
- Treasury inventory and configured target allocation.
- Recent executions and cooldown state.

Guardrails:

- Max trade size per asset.
- Daily notional cap.
- Cooldown between trades per asset.
- Max allowed slippage.
- Minimum on-chain liquidity / max price impact.
- Optional volatility guard (pause during extreme move).

Outputs:

- `hold` or `proposed action`.
- Deterministic reason codes.
- Calculated trade size and expected post-trade deviation.

## 6) Execution model

Phased rollout:

### Phase A: Read + decide only (no trades)

- Run daemon and persist full decision logs.
- Compare with manual expected actions for at least 7 days.

### Phase B: Approval-gated live

- Decision generated automatically.
- Requires explicit approval (API/admin token) to execute.

### Phase C: Autonomous live

- Executes automatically if all checks pass.
- Approval path remains available for overrides.

Execution requirements:

- Pre-trade simulation.
- Idempotency key per decision to prevent duplicate sends.
- Post-trade verification (actual tx + balance deltas).
- Automatic retry only for safe, transient failures.

## 7) RPC optimization plan (critical)

The biggest win is reducing calls per pool read.

### 7.1 Batch account reads

Use `getMultipleAccounts`/`getMultipleAccountsInfo` for pool account fan-out:

- Whirlpool state
- vault A/B
- oracle
- required tick arrays

Target: collapse 5-15 calls into 1 batched call per pool snapshot.

### 7.2 Tiered cache policy

- Pool config/static metadata: long TTL (minutes-hours).
- Tick arrays: medium TTL (seconds-minutes) with invalidation on relevant updates.
- Vault balances: short TTL (1-5s).
- Derived metrics (price/liquidity/impact): very short TTL (1-2s) or recompute on subscription update.

### 7.3 WebSocket subscriptions

Prefer push updates for high-churn accounts:

- `onAccountChange` on pool/vault/oracle.
- Poll only as fallback health check.

### 7.4 Precomputed pool snapshot service

Build an internal in-memory indexer:

- One collector fetches + subscribes.
- Other components read from shared snapshot (no duplicate RPC work).

### 7.5 Optional private RPC

Only if batching + cache + subscriptions still exceed provider limits:

- Run a modest pruned private RPC.
- Keep architecture provider-agnostic so migration is low risk.

## 8) API surface for app/agents

Read endpoints (v1 proposal):

- `GET /api/treasury-sync/health`
  - daemon status, last successful run, mode, kill switch state.
- `GET /api/treasury-sync/state`
  - latest market snapshot + latest decision per asset.
- `GET /api/treasury-sync/runs?limit=N`
  - recent runs and outcomes.
- `GET /api/treasury-sync/decisions?asset=sabtc&limit=N`
  - decision history with reason codes.

Control endpoints (admin-only):

- `POST /api/treasury-sync/kill-switch` (`on|off`, reason)
- `POST /api/treasury-sync/mode` (`dry_run|approval|live`)
- `POST /api/treasury-sync/approve/:decisionId` (for approval-gated phase)

## 9) Scheduling and concurrency

- Single leader worker (avoid duplicate execution).
- Lock file or DB advisory lock per run.
- Separate cadences:
  - fast market refresh loop
  - slower policy/evaluation loop
  - execution queue processor

Recommended defaults:

- Market refresh: 5-10s
- Decision loop: 30s
- Cooldown per asset: 2-10m (policy dependent)

## 10) Safety and failure handling

Hard stops:

- Kill switch enabled.
- RPC unhealthy beyond threshold.
- Price source disagreement beyond max tolerance.
- Missing liquidity or excessive projected impact.

Failure classes:

- `transient_rpc`
- `provider_rate_limited`
- `simulation_failed`
- `policy_blocked`
- `execution_reverted`
- `post_trade_mismatch`

Each failure must record:

- machine-readable code
- human-readable reason
- retry decision

## 11) Observability

- Structured JSON logs for all decisions and executions.
- Metrics:
  - run duration
  - RPC calls/run
  - cache hit rate
  - decision counts by action
  - execution success/failure rates
  - slippage realized vs expected
- Alerts:
  - no successful run in X minutes
  - repeated execution failures
  - daily cap reached
  - kill switch toggled

## 12) Implementation phases

### Phase 0 - Spec + config

- Finalize assets, thresholds, and guardrails.
- Define env/config schema and defaults.

### Phase 1 - Data collector + cache

- Hyperliquid fetcher + Orca batched reader + subscriptions.
- In-memory snapshot and cache metrics.

### Phase 2 - Decision engine (dry run)

- Policy evaluation and persistent decision logs.
- Add read endpoints.

### Phase 3 - Execution plumbing

- Simulation, execution adapter, post-trade checks.
- Keep mode `dry_run` by default.

### Phase 4 - Approval-gated live

- Admin approval endpoint and audit trail.

### Phase 5 - Autonomous live

- Enable live mode for selected assets after stability criteria.

## 13) Acceptance criteria

Before live autonomous mode:

- 7+ days dry-run with stable decision quality.
- No unresolved post-trade mismatch in approval mode.
- RPC call volume reduced by at least 70% vs naive per-request polling baseline.
- Cache hit ratio above target (e.g. >80% for non-vault accounts).
- End-to-end audit trail from snapshot -> decision -> execution -> verification.

## 14) Open decisions to finalize

- Rebalance objective definition:
  - strict peg bands vs inventory skew targets.
- Exact Hyperliquid fields used (mid, mark, or blended).
- Approval UX and operator roles.
- Whether to isolate daemon in separate process/service unit.
- Exact assets in initial rollout beyond SABTC/SAETH.

---

If desired, the next planning doc can define a concrete config schema (`json`/env), reason codes enum, and SQL table DDL for immediate implementation.
