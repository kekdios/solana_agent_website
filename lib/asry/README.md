# ASRY treasury helpers

## Price & reward (`asry-price.cjs`, `receive-confirm-and-reward.cjs`)

- **`getAsryPriceUsd()`** — fixed **$100 / ASRY** until you replace with pool/oracle logic.
- **`receiveStableConfirmAndReward()`** — waits for **receive success or failure**:
  - **USDC/USDT:** requires **`depositTxSignature`**; confirms tx + verifies treasury credit + infers sender from chain data; USDT path then runs treasury USDT→USDC swap.
- On success: sends sender **`ASRY_REWARD_USD` (default $0.50)** of ASRY: `0.5 / 100 = 0.005 ASRY` (9 decimals → `5000000` atomic).

**ASRY mint:** Treasury ASRY token is [3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw](https://explorer.solana.com/address/3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw); used as default when `ASRY_MINT_ADDRESS` is not set. Optional env: `ASRY_DECIMALS=9`, `ASRY_REWARD_USD=0.5`. Treasury must hold enough ASRY.

```bash
npm run treasury:receive-reward -- USDT 0.5 ignored_sender <deposit_tx_sig>
npm run treasury:receive-reward -- USDC 0.5 ignored_sender <deposit_tx_sig>
```

---

## `receive-stable-to-treasury.cjs` — **single receiving function**

One API for **USDT** or **USDC** after funds hit **TREASURY_SOLANA_ADDRESS**:

| Asset | Behavior |
|-------|----------|
| **USDT** | Jupiter **USDT → USDC** on treasury (normalize to USDC). |
| **USDC** | **SPL transfer only** — send USDC to **`treasuryUsdcAta`** (treasury wallet’s USDC ATA). **No Jupiter.** Optional: `buildUnsignedUsdcTransferToTreasury({ fromOwnerPubkey, treasuryAddress, amountAtomic, connection })` for payer to sign. |

```bash
npm run treasury:receive -- USDT 0.5
npm run treasury:receive -- USDC 2.0
```

```js
const { receiveStableToTreasury } = require("./receive-stable-to-treasury.cjs");
await receiveStableToTreasury({
  asset: "USDT",
  amount: "0.5",
  treasuryAddress: process.env.TREASURY_SOLANA_ADDRESS,
  signerKeypair: keypair,
});
```

---

## `treasury-usdt-to-usdc-jupiter.cjs` (used inside receive for USDT)

**Jupiter** (`lite-api.jup.ag`) — Solana-native quotes, **direct routes only** by default (`onlyDirectRoutes=true`), optional **priority fees** to land ahead of mempool spam. Use this path if LI.FI / cross-chain aggregation saw junk txs around your swap.

```bash
npm run treasury:swap-usdt-jupiter              # 0.5 USDT → USDC
npm run treasury:swap-usdc-jupiter              # 0.5 USDC → USDT
npm run treasury:swap-usdt-jupiter -- --dry-run
```

Env (optional): `JUPITER_PRIORITY_LEVEL=veryHigh`, `JUPITER_PRIORITY_MAX_LAMPORTS=2000000`, or fixed `JUPITER_PRIORITY_LAMPORTS=500000`. `JUPITER_ONLY_DIRECT=false` allows multi-hop if direct pool illiquid.

---

## `treasury-usdt-to-usdc.cjs` (LI.FI)

Converts **treasury-held USDT → USDC** on Solana using **LI.FI** (`https://li.quest`), same stack as SOL→BTC in `api-server.cjs`.

**Flow**

1. Sender sends **USDT** to the treasury Solana address (SPL token account).
2. When you want USDC on treasury instead, run a swap for the USDT balance (or part of it).
3. **`SOLANA_PRIVATE_KEY`** signs the swap transaction.
4. **`TREASURY_SOLANA_ADDRESS`** must be the **same** pubkey as that keypair — only the wallet that holds the USDT can swap it. If you change treasury, use the matching private key in `.env`.

**Testing amount**

Use **0.5** of whichever stable is under test: **0.5 USDT** for this USDT→USDC path; when testing USDC-only flows later, use **0.5 USDC** there. Override with `TREASURY_TEST_SWAP_USDT` in `.env` or pass an amount on the CLI.

**Local test**

```bash
npm run treasury:swap-usdt-usdc              # 0.5 USDT (default)
npm run treasury:swap-usdt-usdc -- 1.0
```

Requires `.env`: `SOLANA_PRIVATE_KEY`, `TREASURY_SOLANA_ADDRESS`, optional `SOLANA_RPC_URL`. Treasury must hold ≥ swap amount of USDT.

**API**

```js
const { swapTreasuryUsdtToUsdc, keypairFromEnvBase58, usdtToAtomic } = require("./treasury-usdt-to-usdc.cjs");

const keypair = keypairFromEnvBase58(process.env.SOLANA_PRIVATE_KEY);
await swapTreasuryUsdtToUsdc({
  treasuryAddress: process.env.TREASURY_SOLANA_ADDRESS.trim(),
  signerKeypair: keypair,
  amountUsdtAtomic: usdtToAtomic("5.25"), // bigint
  rpcUrl: process.env.SOLANA_RPC_URL,
});
```

Returns `{ signature, expectedUsdcAtomic, explorerUrl, ... }`.

USDC stays on the **same** treasury wallet (USDC ATA).

## Test locally (no secrets)

```bash
npm run test:treasury-usdt
```

Runs unit tests, validation, and a **mocked LI.FI** path (sign + `dryRun`, no broadcast, no real keys).

Optional real LI.FI quote check (needs network):

```bash
npm run test:treasury-usdt:lifi
```

**Dry run with your `.env`** (quote + sign, no send):

```bash
npm run treasury:swap-usdt-usdc -- --dry-run
```

Requires treasury USDT + matching keys for a successful LI.FI quote.
