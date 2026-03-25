# ASRY — Development plan

**Last reviewed:** March 2026.

> **Note:** This is a delivery plan, not a live spec. Implemented behavior today is in **`api-server.cjs`** (e.g. `/api/asry-info`, `/api/asry/transactions`, `POST /api/asry/claim-from-deposit`) and **`lib/asry/`**.

**Policy reference:** [ASRY-TREASURY-AND-YIELD-PLAN.md](./ASRY-TREASURY-AND-YIELD-PLAN.md) (§0.1 deployment phases, §0.2 critical path, §16 implementation priorities).

**Scope:** Build order, deliverables, error budget, and graduation criteria for **website_bootstrap** → optional **production_hardened**. All initial components live on the **website stack**; no cold wallets or offline process until graduation.

**Model:** ASRY follows a **batched epoch profit-sharing / claim model**. Temporary anti-spam floor: **minimum claim = $0.10** (testing default; may increase later).

---

## 1. Build order (from policy §0.2)

| Phase | Focus | Gate |
|-------|--------|------|
| **P0** | **Receiving** + **Sending** (money in / money out) | Must meet **error budget**; else **abandon ASRY rollout**. |
| **P1** | **On-chain smart contract(s)** (epoch state, claims, distributor, pause) | After P0 acceptable; do not use contracts to paper over broken rails. |
| **Bootstrap** | Epoch claim flow + health JSON + `deployment_phase: website_bootstrap` | Enables E2E and agent integration. |

P0 and Bootstrap can overlap (e.g. health endpoint early); **P1 starts only when P0 is on track.**

---

## 2. P0 — Receiving (inbound)

**Goal:** Every user-visible path for **money or value coming in** works reliably and is measurable.

### 2.1 In-scope flows

| Flow | Description | Exposed via |
|------|-------------|-------------|
| **USDC → treasury** | User pays USDC to a published address; system detects and records. A **0.05% fee** is held back from each receive. | API + (optional) webhook / polling |
| **USDT → treasury** | Same for USDT; may normalize to USDC per policy §3.3. A **0.05% fee** is held back from each receive. | Same |
| **Receive USDT or USDC** | `receiveStableToTreasury`. **USDT** → Jupiter → USDC. **USDC** → **SPL transfer only** to `treasuryUsdcAta` (no Jupiter); confirm balance or use `buildUnsignedUsdcTransferToTreasury` for payer tx. | Script / API |
| **Deposit confirmation** | User pays to treasury address → confirm payment and update state (no invoice API). | Confirm pipeline / API |

### 2.2 Deliverables

- [ ] **Receiving API** — Deposit address (published); optional expiry and amount. **0.05% receive fee** on USDC/USDT (held back from each transaction).
- [ ] **Confirmation pipeline** — On-chain or backend check that payment landed; idempotent confirmation; store tx sig + amount.
- [ ] **Idempotency** — Same idempotency key / id never double-counts or double-confirms.
- [ ] **Errors** — Structured error codes (e.g. `payment_underpaid`, `tx_not_found`); no silent failure.
- [ ] **Logging + metrics** — Every receive attempt (success/fail) log; counter or metric for success rate and latency.

### 2.3 Out of scope for P0 (can follow later)

- Complex treasury strategy logic beyond receive confirmation.

---

## 3. P0 — Sending (outbound)

**Goal:** Every user-visible path for **money or value going out** works reliably and is measurable.

### 3.1 In-scope flows

| Flow | Description | Exposed via |
|------|-------------|-------------|
| **USDC payout (yield)** | After delay/cooldown, send USDC to eligible wallet(s). Bootstrap: **website/API signs** (§0.1). | API or batch job that builds + submits txs |
| **USDC refund / manual send** | One-off or admin-initiated USDC transfer from treasury. | Internal tool or API with guardrails |
| **ASRY out (if any)** | E.g. airdrop, test mint — only if part of bootstrap test flows. | Same |

### 3.2 Deliverables

- [ ] **Send pipeline** — Build transfer tx(s); submit; confirm on-chain; store tx sig; idempotent (same payout id → at most one send).
- [ ] **Retries** — Defined retry policy for transient RPC/tx failures; no unbounded retries without alerting.
- [ ] **Stuck state handling** — If tx never confirms, mark as failed or pending_review; no silent “in flight forever.”
- [ ] **Errors** — Structured codes (e.g. `insufficient_balance`, `rpc_error`, `tx_dropped`); surface to operator or API.
- [ ] **Logging + metrics** — Every send attempt (success/fail/timeout); success rate and latency.

### 3.3 Out of scope for P0

- **Offline** signing (production only); bootstrap uses **website-held** signer.
- Merkle claim (user pulls) — can be P1 when on-chain program exists.

---

## 4. P0 — Error budget & abandon-ship

**Define up front** (tune to your risk):

| Metric | Target (example) | Measurement |
|--------|-------------------|-------------|
| **Receive success rate** | e.g. ≥ 99% of **confirmed** payments correctly credited within N minutes. | Numerator: credited; denominator: on-chain confirmed to treasury address. |
| **Send success rate** | e.g. ≥ 99% of **intended** payouts result in confirmed tx within M minutes. | Numerator: confirmed tx; denominator: payout attempts. |
| **Stuck / unrecoverable** | Zero or bounded (e.g. &lt; 0.1% of volume) with manual runbook. | Count of payouts/receives stuck &gt; 24h without resolution. |

**Abandon-ship (policy §0.2):** After **reasonable hardening** (e.g. 2–4 weeks of iteration, retries, and fixes), if P0 **still** exceeds error budget or produces **unacceptable** stuck states / support load → **stop ASRY rollout**. Do not add P1 or more features on top of a broken receive/send rail.

**Checkpoint:** Before starting P1, sign off that P0 meets the budget (or explicitly accept a revised budget and document why).

---

## 5. P1 — On-chain smart contract(s)

**Goal:** Encode **rules** on-chain (distributor, merkle/claim, pause, optional swap wrapper) so state is **verifiable**, not DB-only. **Secondary** to P0.

### 5.1 Suggested scope (minimal)

| Component | Purpose |
|-----------|---------|
| **Distributor / claim state** | Holds epoch totals, claim records, pause flag, cooldown or period; optionally holds USDC vault; users **claim** (pull) or admin **distributes** (push) per design. |
| **Pause authority** | Multisig or single upgrade authority can set pause; readable by API/health. |
| **Epoch finalization** | Finalize ended epoch; compute capped distributable bonus; fund payout vault; publish finalized state. |

### 5.2 Deliverables

- [ ] **Account schema** — PDAs, account sizes, who can write what; document in repo (e.g. `docs/asry-program-accounts.md` or in program crate).
- [ ] **Instruction set** — e.g. `initialize`, `request_redeem`, `finalize_epoch`, `claim`, `set_pause`, etc.; list with args.
- [ ] **Deploy** to devnet first; verify with integration tests.
- [ ] **Health / API** — Read pause + root from chain; expose in `GET /api/asry/health` (e.g. `pause_authority`, `merkle_root`).
- [ ] **Audit** — Before mainnet; multisig upgrade authority.

### 5.3 Out of scope for P1 (later)

- Full **offline** redemption bot (production graduation).
- Cold sweep / hot buffer **automation** (production runbooks).

---

## 6. Bootstrap — Website stack & health

**Goal:** All components run on the **website** (or same deployment); **no cold, no offline**; `deployment_phase: website_bootstrap`.

### 6.1 Deliverables

- [ ] **Health endpoint** — `GET /api/asry/health` (or static `asry-health.json`) with fields from policy §14.1 (**interim:** `GET /api/asry-info` is implemented):
  - Required: `policy_version`, `deployment_phase` (= `website_bootstrap`), `payout_execution` (= `website_hot_testing`).
  - As available: `pause_authority`, `btc_price_usd`, `ltv_attestation`, `emergency_mode`, `degraded_mode`, `yield_eligible`, `redemption_cooldown_days`, `redemption_delay_days`, `current_epoch_id`, `current_epoch_end_iso`, `minimum_claim_usd`, etc.
- [ ] **Treasury hot wallet** — One or more keys (env or keystore) used for receives and sends; **not** cold; document that this is bootstrap-only.
- **ASRY mint (treasury):** [3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw](https://explorer.solana.com/address/3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw) — default in `lib/asry/asry-price.cjs` and receive-reward flow.

### 6.2 Repo / code layout (suggestion)

```
website/
  api-server.cjs          # existing; add ASRY routes
  routes/
    asry/
      health.cjs           # GET /api/asry/health
      receive.cjs          # confirm inbound
      send.cjs             # payout, refund (bootstrap: server signs)
  lib/
    asry/
      confirm-payment.cjs   # confirm tx, idempotent
      build-send.cjs       # build transfer tx(s)
      metrics.cjs          # success/fail counters for P0
  docs/
    ASRY-TREASURY-AND-YIELD-PLAN.md
    ASRY-DEVELOPMENT-PLAN.md  # this file
```

Programs (P1) can live in `programs/` or a separate repo; link from this doc.

---

## 7. Testing strategy

**Stablecoin test size:** use **0.5** of the token being exercised — **0.5 USDT** when testing USDT paths (e.g. USDT→USDC swap), **0.5 USDC** when testing USDC send/receive paths. Keeps mainnet tests small and repeatable. The treasury swap script defaults to **0.5 USDT** if no amount is passed (`TREASURY_TEST_STABLECOIN_AMOUNT` in `lib/asry/treasury-usdt-to-usdc.cjs`).

| Layer | What to test |
|-------|----------------|
| **Unit** | Confirm logic (amount matching, idempotency keys, error codes). |
| **Integration** | With devnet (or testnet): send USDC/USDT to treasury → confirm tx; send USDC (payout) → confirm tx. |
| **E2E** | Full receive path and send path (payout) once; measure success rate over N runs. |
| **Load (optional)** | Sustained receive/send volume to find timeouts and bottlenecks. |

**P0 gate:** E2E and integration tests **green** and **error budget** met (or explicitly waived with doc).

---

## 8. Graduation to production_hardened

When moving from **website_bootstrap** to **production_hardened** (policy §0.1):

- [ ] **Cold + hot buffer** — Runbooks and (if automated) sweep + replenish logic per §2.1–§3.2.
- [ ] **Offline redemption bot** — Sign payouts **off** the public server; **§10.2** workflow (export list → sign offline → broadcast).
- [ ] **Health** — Set `deployment_phase: production_hardened`, `payout_execution: offline_bot`.
- [ ] **Bump** `policy_version` in repo and health JSON.
- [ ] **Runbooks** — Attestation cadence, §6/§6.1 transitions, cold sweep, offline batch export.

---

## 9. Summary checklist

| # | Item | Phase |
|---|------|--------|
| 1 | Receiving API + confirmation for USDC/USDT; idempotency; errors; metrics | P0 |
| 2 | Sending pipeline + retries + stuck handling; errors; metrics | P0 |
| 3 | Error budget defined; abandon-ship decision if P0 fails | P0 |
| 4 | Health endpoint with `deployment_phase`, `policy_version`, and §14.1 fields | Bootstrap |
| 5 | Treasury hot wallet integration + epoch metadata (bootstrap) | Bootstrap |
| 6 | On-chain program(s): account schema, instructions, deploy devnet, pause + root in health | P1 |
| 7 | Graduation: cold, offline bot, runbooks, `production_hardened` | Post-bootstrap |

**Policy:** [ASRY-TREASURY-AND-YIELD-PLAN.md](./ASRY-TREASURY-AND-YIELD-PLAN.md). **Critical path:** P0 first; P1 next; abandon if P0 doesn’t clear the bar.
