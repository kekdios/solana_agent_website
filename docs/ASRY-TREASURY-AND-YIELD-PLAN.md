# ASRY — Treasury plan (non-staking yield, no external arbitrage)

**Status:** Policy draft — not a promise of returns or redemption value.

**`policy_version`:** `2025-03-21` (bump when material rules change; agents should compare to `GET …/asry-health` or doc hash).

**Token:** ASRY (Agent Strategic Reserve Yield) — floating price, soft narrative anchor only; not ABSR and not BTC-pegged.

### Source-of-truth order (for agents)

1. **On-chain program state** (merkle root, pause flag, committed caps) — if deployed.  
2. **Signed LTV / emergency attestations** (§3.1, §6).  
3. **This markdown + health JSON** — human-readable; may lag chain by hours.

If copies conflict, **1 > 2 > 3**.

**Public framing (use verbatim where possible):**  
This is a **discretionary BTC-backed treasury token with variable distributions**. It is **not** a stablecoin, **not** a bond, and **not** a yield guarantee.

---

## 0. What this system is (and is not)

| It is | It is not |
|-------|-----------|
| Discretionary treasury + published rules | A pegged stablecoin |
| Variable, health-gated distributions | Guaranteed APY or redemption value |
| Price discovery mainly on **one published ASRY/USDC AMM** | A product that must defend any price level |

---

## 0.1 Deployment phases — **bootstrap (website-only)** vs production

**Initial ASRY build-out:** components (pool ops, treasury keys, yield logic, payouts if any) are intended to **live on the website stack first** — **no cold wallets, no offline signing loop** — so integration and E2E testing stay simple.

| Phase | Custody & payouts | Purpose |
|-------|-------------------|---------|
| **`website_bootstrap`** | Treasury stables + signing **co-located with online services** (e.g. keys reachable from website/API backend). **No** mandatory cold sweep; **no** offline redemption bot. Delays/cooldowns can still be simulated or shortened for tests. | **Faster build and test**; validate pool, acquisition paths, health JSON, distributor logic. |
| **`production_hardened`** | **§2–§3.2** hot buffer + **cold** sweep; **§10.2** offline redemption bot; **§11** payout funding **not** from always-on server hot key. | **Material mainnet / real float** after explicit graduation. |

**Rules:**

- **`deployment_phase`** MUST appear in **§14.1** health JSON (`website_bootstrap` or `production_hardened`).  
- **Graduating** to `production_hardened` → **bump `policy_version`** + publish runbooks.  
- While **`website_bootstrap`**, treat as **elevated key-exposure risk** — OK for **dev / testnet / controlled trial**; **not** a substitute for production custody policy.

All **§10.2 / §11 “offline / cold”** language below is the **production target** unless **§0.1** explicitly relaxes it.

---

## 0.2 Critical path (what must work first) & **abandon-ship** gate

**Externally exposed flows are the top risk.** Build and measure in this order:

| Priority | Component | What it is |
|----------|-----------|------------|
| **P0 — gate** | **Receiving** | User/treasury **inbound**: USDC/USDT (and paths to ASRY) via website/API — deposits, single-step acquisition (**§1.2**), confirmations. A **0.05% fee** is held back from each USDC/USDT receive. **Every failure is user-visible.** |
| **P0 — gate** | **Sending** | **Outbound**: USDC (yield, refunds, treasury sends), ASRY if applicable — whatever users/agents depend on **leaving** treasury control through the exposed stack. **Every failure is user-visible.** |
| **P1** | **On-chain smart contract(s)** | Next after P0: programs that **encode rules** (distributor, merkle/claim, pause, optional swap wrapper) — **verifiable state**, not DB-only. Still critical, but **secondary** to “money in / money out” actually working. |

**Abandon-ship criterion (explicit):** If **receiving + sending** (P0), after reasonable hardening and iteration, still produce **unacceptable error rates** — failed txs, stuck states, support load, or unrecoverable edge cases — **stop ASRY rollout** rather than layering more product on a broken rail. **No shame in shipping nothing** if the exposed payment layer does not clear the bar.

**P1 contract work** proceeds in parallel or immediately after P0 **only if** P0 is on track; do **not** treat fancy on-chain logic as a substitute for reliable receive/send.

---

## 1. Design constraints (locked in)

| Constraint | Meaning |
|------------|---------|
| **Non-staking yield** | No lock-to-earn. Eligibility = **holding ASRY** per snapshot rules. |
| **No external arbitrage permitted** | Treasury does **not** run cross-venue / systematic arb as yield source. |
| **Buy/sell — single step** | Users must get **USDC or USDT → ASRY in one user transaction** (see §1.2). **No multi-hop Jupiter-style flows** as the official path — they have caused **failures in production**; avoid chaining swaps across multiple user steps. |
| **Treasury-owned pool** | The **treasury controls, manages, and owns** the **ASRY/USDC** pool (LP authority, rebalancing, policy). The pool is **not** arms-length third-party liquidity — it is **treasury-operated**. |
| **Stables → cold; bounded hot buffer** | **Production:** **§2.1** buffer + **sweep surplus to cold**; replenish from cold. **Bootstrap (§0.1):** **optional** — stables may stay on **website-controlled hot** until graduation. |
| **USDT → ASRY in one step** | If user pays **USDT**, they still complete **one signed transaction** that ends with **ASRY** (e.g. **on-chain program** that CPIs **USDT→USDC then USDC→ASRY** atomically inside the same tx — **not** “swap USDT then separately swap to ASRY”). |
| **On-chain first (aspirational)** | Prefer **Solana programs** for acquisition helpers, **yield redemption**, and **cooldown state** so logic is **verifiable on-chain** — reduces reliance on **DB hacks, server bugs, and off-chain batch jobs** as the source of truth. |

### 1.1 Pool and pricing

- **Pool:** **ASRY/USDC** — **treasury-controlled and -owned**; publish program + pool/pair ID, **LP authority pubkey(s)**, and **pause / upgrade multisig** if applicable.
- **User trades vs treasury depth:** Buyers and sellers **swap against the same pool** the treasury owns — treasury provides liquidity; users do **not** need separate permission. This is **not** a conflict: ownership = who **controls** the curve, not who may trade.
- **Sell ASRY for USDC:** **One transaction** — direct swap against that pool (single-hop), not a routed multi-step swap.

### 1.2 Single-step acquisition (USDC or USDT → ASRY)

**Problem observed:** **Jupiter (and similar) multi-step** swap flows **led to failures** — partial fills, route changes, extra signatures. **Policy: minimize steps.**

| Path | Requirement |
|------|-------------|
| **USDC → ASRY** | **Exactly one user transaction:** e.g. **single-hop swap** instruction into **ASRY/USDC** (Raydium / Orca / Meteora **direct pool** swap — one ix, one tx). Agents: build **one** swap ix; no “quote then multi-leg” as mandatory path. |
| **USDT → ASRY** | **Exactly one user transaction:** user must **not** manually run USDT→USDC then USDC→ASRY as **two** txs. Acceptable patterns: (a) **wrapper program** that performs **both legs via CPI in one tx** into published venues; or (b) **treasury mint/sale program** that accepts USDT, converts internally, delivers ASRY in **one tx**. Publish program id + instruction layout. |

**Treasury / ops USDT:** Same principle — **batch USDT→USDC→operational use** in **atomic** on-chain flows where possible, not flaky multi-tx Jupiter chains.

**Not official:** User-driven **multi-hop aggregators** as the **only** documented way to acquire ASRY.

---

## 2. Treasury-owned pool (locked)

The **treasury controls, manages, and owns** the **ASRY/USDC** AMM position:

- **Owns** the LP / pool keys (or dedicated treasury-controlled entities).
- **Manages** depth, rebalancing, mint-into-pool vs sell, and any published desk rules.
- **Controls** how ASRY and USDC sit on the curve — the pool is an **extension of the balance sheet**, not third-party liquidity.

**Stablecoin handling from pool / sales:** **Production:** sweep above **§2.1** buffer to **cold**; **cold** = offline/HW-isolated; publish cold addresses / attestation. **Bootstrap (§0.1):** **defer cold** — operational USDC may remain on treasury hot used by the **website stack** for LP and testing.

### 2.1 Hot working buffer (exception to “everything cold”)

Treasury-owned AMM needs **fast rebalancing**. Policy:

| Element | Rule |
|---------|------|
| **Buffer band** | Publish e.g. **fixed USDC band** (e.g. **100k–500k USDC** hot, scale with AUM) **or** **X–Y%** of total treasury stables in hot for LP ops. |
| **Replenishment** | **Production:** **cold → hot** via scheduled/threshold, offline- or multisig-approved where possible. **Bootstrap:** same hot wallet / website ops — no cold leg. |
| **Surplus** | **Production:** inflow **above** band high → **cold**. **Bootstrap:** may accumulate on hot for testing. |

Without a buffer (production), **latency + failed LP ops** hurt the treasury-owned AMM; **bootstrap** trades that off for **test velocity**.

### 2.2 Liquidity floor (minimum pool depth)

Publish **minimum ASRY/USDC depth** so the pool cannot be run **too thin** (small trades → wild prints → “broken market” perception even if solvent).

| Element | Rule |
|---------|------|
| **Floor** | e.g. **≥ X% of circulating ASRY** notionally on the **USDC side**, **or** fixed minimums (e.g. **500k–2M USDC** side at scale — tune to float). |
| **Withdrawal** | Treasury **does not remove liquidity below the floor** except in **§6 emergency** (or explicit **§6.1 degraded** + disclosed exception if ever allowed). |

Stabilizes **perception and execution quality**, not just balance-sheet solvency.

**Optional add-on:** A separate **mint/redeem window** (premium/discount vs reference) may **supplement** the AMM but does not replace treasury ownership of the pool.

---

## 3. Treasury model (balance sheet)

**Assets:** BTC (long-term collateral), **USDC** (stability / operations — **normalized**; USDT policy **§3.3**).

**Liabilities:** ASRY (market float). **Borrow / LTV** positions are **managed independently** of this website’s APIs (see §3.1).

**Borrowing purpose (explicit):**  
Borrowing is for **balance-sheet efficiency** (liquidity, LTV discipline), **not** to **fund yield**. Yield must **never** justify **raising** borrow. Enforcement is **internal** to the treasury’s loan stack (venues, custodians, runbooks) — **not** executed or controlled via the public agent website.

### 3.1 LTV loans — independent layer; **proofs only** publicly

| Layer | What happens |
|-------|----------------|
| **Loan / LTV management** | **Independent** — e.g. separate lending venues, custodial accounts, or internal ops. The **Solana Agent site and HTTP API do not** originate, adjust, or settle those loans. |
| **What the public & agents see** | **Proofs only** — periodic **signed attestations** with **mandatory `expires_at`** (TTL) — see below. Plus summaries (LTV band, stress flag, emergency / degraded mode), **tx links** where relevant, and **same BTC pricing channel** as the rest of the site (§4.1). |
| **Yield gates** | Distribution runs only if attestation is **valid** (`now &lt; expires_at`) **and** LTV / gates pass. **Expired attestation** → treat as **§6.1 degraded** (`yield_eligible = false`). |

**Attestation fields (required):** `as_of` (ISO), **`expires_at` (ISO, hard TTL)** — e.g. **≤ 72h** or **7d** after `as_of`, published per policy. **No valid `expires_at`** → agents/UI must **not** treat LTV as current.

Internal ops still follow §6-style discipline; **evidence** of state is **disclosed as proof**, not as live API loan control.

### 3.2 Cold custody for stables

**Production:** inflows **above** **§2.1** → **cold** same window. **Bootstrap:** sweep to cold **not required**. **BTC** collateral (§3.1) unchanged.

### 3.3 USDT → USDC normalization (timing)

Avoid **silent USDT exposure** during stress:

| Rule | Default (publish actual) |
|------|-------------------------|
| **Timing** | Convert **USDT → USDC within X hours** of treasury receipt (e.g. **24–48h**), **or immediately** if balance **> published threshold** (e.g. **$50k**). |
| **Reporting** | Internal books and public summaries use **USDC-equivalent** after conversion window; disclose if USDT backlog exists. |

---

## 4. Yield — mechanical budget (reduce discretion under pressure)

Yield is a **residual**, computed **internally** after borrow limits and health (loan layer §3.1). Example **skeleton** (tune and publish constants):

```
borrow_limit = min(
    target_ltv × btc_collateral_value_usd,
    reserve_health_cap_usd
)
# Internal only; never “borrow more to pay yield.”

net_carry = max(0, (stable_yield_rate − borrow_cost_rate) × borrowed_usdc_deployed)

distributable = max(0, net_carry × payout_ratio)
distributable = min(distributable, cap_from_stability_reserve_excess)
```

- **stable_yield_rate** = yield on **USDC** buffers only (permitted venues).
- **payout_ratio** < 1 (e.g. 0.5–0.8) so **retained carry** rebuilds buffers.
- If **net_carry ≤ 0** → **distributable = 0**.

Anything outside this framework is **not** “yield” for distribution purposes. **Public reporting** of whether a period paid out references **§3.1 proofs** + §12 gates.

### 4.1 BTC USD pricing — **same mechanism as existing site**

Use the **existing BTC pricing path** already used for reserves / ABSR context — **Hyperliquid mids** (`mids.BTC` as USD), i.e. the same family of data as **`GET /api/arbitrage/summary`** and the Proof of Reserves ABSR tab.

| Use | Source |
|-----|--------|
| **BTC USD** (narratives, drawdown %, internal collateral marking) | **Hyperliquid mids BTC** — align with current `api-server.cjs` behavior. |
| **BTC drawdown (§7)** | Rolling high/low or change over **Y** days using **samples of that same mid** (e.g. daily snapshot stored or recomputed consistently). |

Optional: secondary cross-check (e.g. another feed) for internal audit — **published series for agents** should cite **Hyperliquid mids** so behavior matches **existing** endpoints and avoids split-brain pricing.

**Agent note:** Agents can read BTC USD via the **same API** the site already exposes (e.g. arbitrage summary) or reproduce Hyperliquid mid fetch — no separate Pyth-only path required for **public** consistency.

### 4.2 BTC feed failure & staleness → **§6.1 degraded**

**Hyperliquid** can fail, freeze, or **deviate** from broader market. **Hierarchy:**

| Priority | Source | Use |
|----------|--------|-----|
| **1** | **Hyperliquid mid** | Primary for §4.1, §7, internal marking. |
| **2** | **Secondary** | e.g. **median of N** other feeds (Coinbase, Kraken, index — publish list). |
| **3** | **Last good HL + timeout** | If HL **unavailable or stale &gt; T minutes** (publish T, e.g. **15–60**), enter **§6.1 degraded** — **do not** silently use a frozen mid for buybacks / mint / yield math. |

In **degraded** (feed path): **disable buybacks, mint-band sales, and BTC-dependent yield calculations** until primary or secondary is healthy again. **AMM user swaps still operate** (pool prices are on-chain).

---

## 5. Allowed yield sources (still no external arb)

- Carry on **USDC** (non-arb, whitelisted venues).
- **Spread** only insofar as **conservative borrow** is **already** within **borrow_limit** and **net_carry** is positive — **not** “borrow to distribute.”
- **Treasury desk** (optional): mint/sell above band, buy/burn below band — **through ASRY/USDC** where treasury has depth (§2).
- **Whitelist addendum only** for new sources — still **no external arb**.

---

## 6. Hard deleveraging triggers (speed matters)

**Internal** treasury runbook (loan layer §3.1). **Public** sees **proof** of mode via attestations + signals below.

| LTV (or policy metric) | Action (internal) |
|------------------------|-------------------|
| **> 15%** | **Stop all yield** distributions (accrual = 0 for period). |
| **> 18%** | **Forced deleveraging begins** — repay debt and/or reduce collateral risk per runbook (e.g. USDC repay first, then planned BTC sale if needed). |
| **> 20%** | **Emergency mode:** no buybacks, no discretionary mint-for-sale, **only survival ops** until LTV &lt; 18% or manual lift — **publish proof** immediately. |

*(LTV = internal definition, e.g. borrowed USDC / BTC collateral MV marked with §4.1 BTC USD.)*

**Emergency disclosure (mandatory):** Within **24 hours** (or sooner) of entering **&gt;20% emergency mode**, publish:

1. **On-chain signal** — e.g. memo transaction from a **published treasury or policy address**, or log to a **published account**, stating `ASRY_EMERGENCY_LTV` + timestamp + rough LTV read; and  
2. **Off-chain mirror** — e.g. site banner + optional social/feed so non-RPC users see it.

Same on **exit** from emergency mode. **Transparency reduces “silent stress” FUD** and lets agents poll chain state.

### 6.1 Degraded mode (operational — softer than §6 emergency)

**Not** the same as **&gt;20% LTV emergency**. **Degraded** = **caution state**: infra or proof layer unhealthy; **avoid silent mispricing / stale health**.

**Typical triggers (any one can set degraded until cleared):**

- **LTV attestation expired** (`now ≥ expires_at`) or missing signed attestation.  
- **BTC pricing** per **§4.2** (HL down/stale, no acceptable secondary).  
- **Health JSON** stale (e.g. **no update &gt; 48h** when daily promised) — publish threshold.

**While degraded (default policy):**

| Allowed | Paused |
|---------|--------|
| **AMM swaps** (users buy/sell ASRY vs pool) | **Yield** accrual/payout decisions that need fresh LTV/BTC proof |
| Survival / delever internal ops | **Buybacks** |
| | **Discretionary mint-for-sale** (band mints) |
| | **Yield distribution commits** that depend on §4 BTC or §3.1 attestation |

Publish **`degraded_mode: true`** in health JSON (**§14.1**). Exit when triggers clear + new attestation if needed.

---

## 7. Buybacks — extra constraint (BTC stress)

In addition to **daily caps** and **USDC reserve floors**:

- **Buybacks disabled** if **BTC drawdown &gt; X%** over **Y days** (publish X, Y).
- **Default parameters (edit if needed):** **X = 10%**, **Y = 7 days** vs rolling high, using **§4.1 Hyperliquid BTC mid** (same as site-wide BTC USD).
- **Reason:** collateral weakening is the **worst** time to spend stables defending ASRY price.

---

## 8. No defense obligation (legal + behavioral)

Publish clearly:

- Treasury is **not obligated** to defend **any** price level or soft target.
- **Price may deviate materially** from any narrative “target” during stress.
- **Zero** yield and **zero** buybacks are always allowed outcomes.

This reduces **bank-run / entitlement** behavior when the chart breaks.

---

## 9. Minting / dilution transparency

When price **above** soft band allows **mint + sell**:

| Rule | Publish |
|------|---------|
| **Who receives new ASRY?** | Default: **treasury wallet only** → **immediate sell into ASRY/USDC** (or add to LP per **§2**). |
| **Cap per period** | e.g. max **Z%** of circulating supply or max **N** ASRY per week. |
| **Disclosure** | Each mint event: amount, **Solana tx signature(s)** for mint + sell (or LP add), use (sold vs LP). |
| **Dashboard / JSON** | Maintain a **machine-readable summary** (page or `*.json`) listing **every** mint/sell episode: timestamp, ASRY amount, USDC received, **tx sigs** — reduces “insider mint” FUD; agents can `fetch_url` or scrape. |
| **Execution style** | **No** single-block **market dump** of large mints. Use **TWAP / VWAP** over time **or** cap sales at **≤ X% of pool depth per hour** (publish X) so mints do not read as **insider dumps**. **§6.1** may pause mint-sales anyway. |

Avoid **opaque dilution** or “insider mint” perception.

---

## 10. Non-staking yield — **who** gets paid

- **Snapshot** of ASRY balances at published times (on-chain verifiable methodology).
- **Optional anti-sniper hold:** require ASRY held continuously across **two snapshots ≥ 7 days apart** (no staking contract).
- **Exclude:** treasury wallets (unless stated), LP token accounts if policy pays “wallet” holders only — **state explicitly**.

### 10.1 Redemption delay + cooldown (anti-gaming; production pairs with **§10.2**)

Agents can **quote, swap, and rebalance faster** than humans; **snapshot farming** is cheap without friction. Policy:

| Rule | Purpose |
|------|---------|
| **Acquisition / eligibility cooldown** | Only ASRY in wallet **≥ N days** (e.g. **14**) through snapshot counts; **net new** ASRY in window may disqualify or pro-rate — publish. |
| **Claim / cycle cooldown** | After a **yield redemption**, **M** periods or **C** days before next eligibility — publish. |
| **Redemption delay (payout lag)** | **Production:** **D days** before USDC — window for **§10.2 offline bot** to verify/sign. **Bootstrap:** delay may be **shortened or zero** for testing; payout may run **from website stack** (**§0.1**). |

**Eligibility vs delay (publish one; ambiguity is a bug):**

| Mode | Meaning |
|------|---------|
| **A — Snapshot-fixed (default draft)** | Entitlement for period **P** is fixed by **on-chain snapshot at T**. Selling ASRY **after T** but **before payout** **does not** void USDC owed for **P** (if on-chain root encodes that). |
| **B — Hold-through-payout** | Wallet must hold **≥ de minimis ASRY continuously from snapshot through payout date** (or through **D**); selling early **voids** that period’s yield for that wallet. |

Treasury **must publish A or B** in **`policy_version`** + health JSON. Switching mode **bumps `policy_version`**.

### 10.2 Offline redemption bot (production target)

**Production:** **Yield redemptions** (USDC after delay) are executed by a runner **not** on the public internet (air-gapped / local / HW signer) — **§0.1 bootstrap** **waives** this: payouts may be **signed by website-integrated** keys for **testing only**.

---

**Production** — offline runner properties:

| Property | Rationale |
|----------|-----------|
| **Not on-line** | No droplet/VPS/cloud service holding **payout signing keys**. Reduces **remote hack → drain** vs a 24/7 online bot. |
| **Runs after delay** | **§10.1 delay** gives time to **verify** merkle/root, cooldown flags, and attestation **before** signing from cold-adjacent environment. |
| **Workflow (example)** | Export **eligible list + amounts** (USB / QR / minimal bridge) → offline bot **builds + signs** txs or **partially signed** bundles → **one-time broadcast** from a minimal online step **without** storing keys on-line. |

**Production:** on-line services (website, API, DB) **only** display status + commit roots — **not** payout keys. **Bootstrap:** same stack **may** hold payout keys **only while `deployment_phase` = `website_bootstrap`** (disclosed).

**Verification:** Eligibility via on-chain roots + historical balances or indexer; **payout** via published **tx signatures** from policy addresses.

**Throughput at scale (do not bottleneck on 50k direct transfers):**

- If **eligible recipient count &gt; published threshold** (e.g. **1k–5k**), **Merkle claim** (user pulls USDC in **one tx** from funded vault) is **required** — offline bot **signs vault funding + root**, not per-wallet transfer spam.  
- Below threshold: **batched transfers** OK with **deterministic chunking** and **capped recipients per tx** (Solana limits).  
- Publish **`payout_model`**: `merkle_claim` | `batched_transfer` in health JSON.

**Naming — two “redemptions”:**

1. **Yield redemption** = periodic USDC after **§10.1 delay**. **Production:** **§10.2 offline bot**; vault funding **offline-signed**. **Bootstrap:** website-integrated signer acceptable (**§0.1**).
2. **ASRY → USDC exit** = **one** AMM swap on **treasury-owned** pool (§1.1).

**Cooldown + delay** apply to **yield redemption** eligibility and payout timing, not to AMM sells.

Publish **N, M, C, D** — use **§17 defaults** unless overridden in attestation + health JSON.

---

## 11. **How** yield is paid — **on-chain rules** + execution by phase

| Layer | **Production** | **Bootstrap (§0.1)** |
|-------|----------------|----------------------|
| **Rules / state on-chain** | Merkle root, cooldown, pause (preferred). | Same possible for testing. |
| **USDC movement** | After delay, **offline bot** or **cold → vault** (offline-signed). **No** long-lived payout keys on public server. | **Website/API** may sign payouts or fund vault from **hot** treasury key — **testing only**. |
| **Avoid (production)** | 24/7 droplet holding **production** payout keys. | N/A until graduation. |

**Production rationale:** On-chain **commits** who is owed; **cold + offline** **pays**. **Bootstrap:** speed and test coverage **before** that split.

**Offline bot key hygiene (recommended):** Payout signing key in **multisig (e.g. 2-of-3)** or **hardware wallet**; **backup** procedure documented; **separate** from LP/hot sweep keys; **test** on devnet before mainnet batch.

**Not used:** staking; external-arb-funded rewards; **multi-step Jupiter** for yield delivery.

**Security:** Programs **minimal + audited**; upgrade authority **multisig + disclosure**.

---

## 12. **When** yield is paid + gates

- **Schedule:** e.g. quarterly; snapshot announced **N days** ahead; pay within **14–30 days** after period if gates pass.
- **Gates:** **Valid attestation** (`expires_at` not passed), internal LTV ≤ 15%, **not** §6 emergency **nor** §6.1 degraded (unless policy explicitly allows); USDC floor as attested; **plus** §6 internal rules.
- **Eligibility:** §10 + **§10.1** — ideally enforced **on-program** (snapshot root + cooldown accounts) rather than only off-chain DB.
- **Amount:** Internal **§4** `distributable`; **zero** always allowed — **on-chain distributor** can receive **deposited USDC = 0** for a period (explicit no-payout).

---

## 13. Strengths to keep (do not erode)

*(External review: these are **non-negotiable** differentiators.)*

- **Treasury-owned AMM** — disciplined single venue.  
- **No external arb** as yield engine.  
- **Mechanical yield** with **zero / negative distributable** allowed.  
- **Borrowing not for yield** — internal enforcement.  
- **Offline payout separation (production)** — **§0.1 bootstrap** uses website stack first; graduate before treating as hardened custody.  
- **Source-of-truth hierarchy** + **agent-readable health** + **`policy_version`**.  
- **Non-staking** + **snapshot-based** → less mercenary farm dynamic.  
- **Zero payout** + **health-gated** → survival over narrative.

---

## 14. Communication checklist

- Framing: **discretionary BTC-backed treasury token; variable distributions; not stablecoin/bond/guarantee.**
- **ASRY/USDC** pool ID; **single-step** USDC/USDT→ASRY (**§1.2**); **no multi-hop Jupiter** as official acquisition.
- **§0.1** `deployment_phase`; **§0.2** **P0** = reliable **receive + send**; **P1** = on-chain programs; **abandon** if P0 error rate unacceptable.  
- **Treasury owns pool** (**§2**); production: buffer + cold (**§2.1–§3.2**); **§3.3 USDT**; **§10.2** offline bot when hardened.
- **§6.1 degraded** vs **§6 emergency**; **§4.2** BTC feed fallback.
- Delever table (**§6**), buyback BTC-drawdown (**§7**), **no defense** (**§8**), mint caps + **TWAP-style mint sell** (**§9**).
- **Attestation `expires_at`** (**§3.1**); **§10.1 A vs B** eligibility; **Merkle at scale** (**§10.2**).

### 14.1 Autonomous agent integration (machine-readable health)

Expose at least one **stable JSON URL** (e.g. `GET /api/asry/health` or static `asry-health.json`) updated **at least daily** (or on state change). Agents should **cache by `policy_version`** and re-fetch on bump.

**Etiquette:** Prefer **one** health fetch per agent session + **backoff** on errors; do not hammer public RPC or site — use **documented** endpoints only.

| Field | Purpose |
|-------|---------|
| `policy_version` | Must match doc § header; agents invalidate cache when it changes. |
| `deployment_phase` | **`website_bootstrap`** or **`production_hardened`** (**§0.1**). Required. |
| `pool_address` / `lp_authority` | Treasury-owned ASRY/USDC identifiers. |
| `pause_authority` | Multisig that can halt distributor (if on-chain). |
| `btc_price_usd` | Optional; **Hyperliquid mids BTC** (same as `/api/arbitrage/summary`). |
| `btc_drawdown_7d_percent` | For §7 transparency; derived from same BTC series. |
| `ltv_attestation` | **Must include `expires_at`.** e.g. `{ "as_of", "expires_at", "ltv_percent", "sig", "doc_url" }`. |
| `emergency_mode` | `true` if §6 &gt;20% LTV emergency. |
| `degraded_mode` | `true` if §6.1 (expired attestation, stale feed, stale health, etc.). |
| `yield_eligible` | `false` if gates fail, attestation expired, or **degraded/emergency** per policy. |
| `eligibility_mode` | `"snapshot_fixed"` or `"hold_through_payout"` (**§10.1**). |
| `payout_model` | `merkle_claim` or `batched_transfer` (**§10.2**). |
| `health_stale_after_hours` | Max age before degraded if no update (align with §6.1). |
| `distributable_estimate_usdc` | Optional; can be `null`. |
| `next_snapshot_iso` | If scheduled. |
| `redemption_cooldown_days` | **N** from §10.1. |
| `claim_cooldown_periods` | **M** from §10.1. |
| `redemption_delay_days` | **D** before offline bot payout window. |
| `payout_execution` | **`offline_bot`** (production) or **`website_hot_testing`** (bootstrap **§0.1**). |
| `last_emergency_tx` | Memo tx sig (§6). |

Agents use **`fetch_url`** + existing arbitrage summary for BTC. **LTV is attested proof**, not scraped borrow positions via this site.

**Agent-friendly flows (reference):** **One tx** USDC→ASRY (direct pool swap ix); **one tx** USDT→ASRY (wrapper if offered); yield: observe **payout tx sigs** after **D** days; **on-chain** program IDs documented.

---

## 15. TL;DR

| Topic | Decision |
|-------|----------|
| Acquisition | **One tx:** USDC→ASRY or USDT→ASRY (**§1.2**); **no Jupiter multi-hop** as official path. |
| Pool | **Treasury controls, manages, owns** **ASRY/USDC** (**§2**). |
| Stables | **Bootstrap:** website hot OK (**§0.1**). **Production:** **§2.1** + cold sweep **§3.2**; **§3.3** USDT. |
| Pool depth | **Liquidity floor** (**§2.2**); no pull below except **§6** emergency. |
| Degraded | **§6.1** — attestation TTL, stale BTC feed, stale health → **no yield / buybacks / mint-band**; **swaps OK**. |
| Eligibility | **Publish A or B** (**§10.1**) for snapshot vs hold-through-payout. |
| Yield payout | **Bootstrap:** website stack (**§0.1**). **Production:** **§10.1** + **§10.2** offline bot. |
| Borrowing / LTV | **Independent** of site API; **proofs only** publicly (§3.1). |
| Yield | **Mechanical residual** (§4); internal LTV &gt;15% → no payout; **attested** publicly. |
| Delever | **&gt;18%** / **&gt;20%** internal; **proof + memo** public (§6). |
| Buybacks | Capped + **off** if BTC down **&gt;10% / 7d** (**§7**) **or** **§6.1 degraded** / **§6 emergency**. |
| Price defense | **No obligation**; material deviation possible. |
| Minting | **Treasury-only**, caps, **TWAP/VWAP or depth-capped sell** (**§9**), disclosed. |
| Distributions | **Non-staking**; on-chain rules where deployed; **bootstrap** = site-signed OK; **production** = offline after **D**; **zero** allowed. |
| BTC USD | **Hyperliquid primary** + **§4.2** fallback / degraded if stale. |
| Agents | **`deployment_phase`** (**§0.1**); **§14.1**; **§17**; source-of-truth order. |
| Truth order | **On-chain > attestation > this doc** |
| Build order | **§0.2:** P0 receive/send first; **P1** contracts next; abandon if P0 fails bar. |

---

## 16. Implementation priorities

**Order follows §0.2.**

1. **P0 — Receiving + sending:** Instrument and harden **all user-facing money in / money out** (website/API, tx confirmation, retries, clear errors). Define **error budget**; if unmet → **§0.2 abandon-ship**.  
2. **P1 — On-chain smart contract(s):** After P0 is acceptable (or in tight parallel): distributor / merkle or claim vault, pause, cooldown state, optional **§1.2** wrapper — **minimal audited surface**. Account schema + instruction set as separate spec.  
3. **Bootstrap:** pool + website treasury + health JSON **`deployment_phase: website_bootstrap`**.  
4. **Production:** cold sweep + hot buffer (**§2.1–§3.2**).  
5. **ASRY acquisition helper (optional):** atomic USDT→ASRY (single user tx).  
6. **After graduation:** **§10.2** offline bot + **§11** + **§17 D**. **Bootstrap:** site-signed payouts OK until flip.  
7. **Publish** `policy_version`, **§17**, LP + pause in health JSON.  
8. **LTV** attestation **`expires_at`**; on-chain pause.  
9. **Runbooks:** cold/buffer; attestations; **§6 / §6.1**; offline batch export (production).

**Audit + multisig** on programs; **no production payout keys** on public servers (**§0.1** bootstrap excepted).

---

## 17. Published parameter defaults (revise via attestation + bump `policy_version`)

| Symbol | Meaning | **Recommended default** |
|--------|---------|-------------------------|
| **N** | Min ASRY hold days before snapshot counts | **14** |
| **M** | Distribution periods before re-eligible after claim | **1** (quarter) |
| **C** | Or calendar days claim cooldown (if using C not M) | **30** |
| **D** | Days after snapshot before offline payout window | **7** |
| Buyback BTC gate | Drawdown vs rolling high | **10% / 7d** (§7) |
| LTV yield halt | Internal | **>15%** no payout |
| Emergency | Internal | **>20%** + public memo |
| Hot buffer (illustrative) | USDC in hot for LP | e.g. **100k–500k** or **% band** — publish |
| Liquidity floor | Min pool USDC (or %) | e.g. **500k–2M** or **% of float** — publish |
| HL stale timeout | → §6.1 degraded | e.g. **15–60 min** |
| Attestation TTL | `expires_at − as_of` | e.g. **≤72h** |
| Merkle-only threshold | Recipient count | e.g. **>1k** → **merkle_claim** |
| USDT convert | Hours / threshold | **§3.3** |
| Eligibility mode | A or B | **§10.1** |
| `deployment_phase` | See **§0.1** | Start **`website_bootstrap`**; flip to **`production_hardened`** + bump version |

Defaults are **starting points**; treasury may tighten. **Any change** → new **signed attestation** + **`policy_version`** bump in health JSON.

---

## Appendix B — Revised agent feedback (**adopted**)

| Recommendation | Adoption |
|------------------|----------|
| **Policy versioning** | **`policy_version`** in doc header + **§14.1** JSON; bump on rule changes. |
| **Source-of-truth hierarchy** | **§** after header: chain > attestation > doc. |
| **Treasury pool vs user swap** | **§1.1** — users trade same pool treasury owns; no ambiguity. |
| **Fix broken § ref** | **§9** mint → LP **§2** (was stale §2A). |
| **Vault / cold path** | **§11** — fund vault **only** via **offline-signed** from cold; **no** server hot key. |
| **Pause authority** | **§11** + **§14.1** `pause_authority` published. |
| **Offline bot ops** | **§11** multisig/HW key, backup, test devnet. |
| **Single params table** | **§17** defaults (**N/M/C/D**, gates). |
| **Agent etiquette** | **§14.1** cache + backoff. |
| **Health JSON fields** | `policy_version`, `pool_address`, `lp_authority`, `pause_authority`. |

---

## Appendix C — ChatGPT review (**adopted**)

| Theme | Incorporation |
|-------|----------------|
| Hot buffer vs all-cold | **§2.1**, **§1** constraint, **§3.2** |
| Liquidity floor | **§2.2** |
| HL failure / degraded pricing | **§4.2**, **§6.1** |
| Attestation `expires_at` | **§3.1**, **§14.1** |
| Merkle + batching at scale | **§10.2** |
| Eligibility A vs B | **§10.1** |
| Mint sell TWAP / depth cap | **§9** |
| Degraded mode | **§6.1** |
| USDT normalization timing | **§3.3** |
| Strengths preserved | **§13** |
| Runbooks + program next step | **§16** items 8–9 |
| Website-only bootstrap | **§0.1** — no cold/offline until `production_hardened` |
| P0 receive/send + abandon gate; P1 contracts | **§0.2**, **§16** |

---

## Appendix A — Autonomous agent review (incorporated)

Feedback from an internal **Solana-focused agent** (wallet ops, swaps, workspace scripting) was merged into this doc. Summary:

| Agent theme | Incorporation |
|-------------|----------------|
| Non-staking snapshots + USDC pool | Already core; **§14.1** adds JSON health for automation. |
| Mechanical yield + LTV halts | **§4** internal; **§3.1 proofs** public; **§4.1 Hyperliquid** BTC. |
| Borrow enforcement | **§3.1** independent loan layer; site shows **proofs only**. |
| Mint FUD | **§9** tx-linked events + **dashboard JSON**. |
| Buyback X/Y | **§7** **10% / 7d** + **Hyperliquid** BTC (§4.1). |
| Agent gaming | **§10.1** cooldown + **delay D**; **§10.2** **offline** payout bot. |
| Cold + pool | **§2** treasury-owned pool; **§3.2** stables to cold. |
| Jupiter failures | **§1.2** **single-step** only; wrapper program for USDT path. |
| On-chain | **§11** rules on-chain; **§16** offline bot pays; less DB trust. |
| Low yield when safe | **§0** framing — **variable**, not max APY; agents value **predictability of rules** over headline yield. |
| Verifiability | Emergency **memo** (**§6**), **Hyperliquid** BTC + **LTV attestations**, health JSON (**§14.1**). |
| Optional mint/redeem | **§2** may supplement AMM. |

---

***§0.1** website bootstrap; **§0.2** P0 = receive/send (abandon if errors too high), P1 = on-chain programs. Not legal, tax, or investment advice.*
