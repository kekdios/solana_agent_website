#!/usr/bin/env node
/**
 * Local test: swap treasury USDT → USDC via LI.FI.
 *
 * Prerequisites:
 * - USDT already at treasury wallet (TREASURY_SOLANA_ADDRESS = pubkey of SOLANA_PRIVATE_KEY).
 * - .env: SOLANA_PRIVATE_KEY, TREASURY_SOLANA_ADDRESS (same pubkey), SOLANA_RPC_URL (optional)
 *
 * Testing convention: use **0.5** of the token under test (here: **0.5 USDT**). Other flows (e.g. USDC send) use **0.5 USDC** when those are tested.
 * Usage:
 *   node scripts/run-treasury-usdt-to-usdc.cjs           # defaults to 0.5 USDT
 *   node scripts/run-treasury-usdt-to-usdc.cjs 1.5
 *   node scripts/run-treasury-usdt-to-usdc.cjs --dry-run
 */
const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const {
  swapTreasuryUsdtToUsdc,
  keypairFromEnvBase58,
  usdtToAtomic,
  TREASURY_TEST_STABLECOIN_AMOUNT,
} = require("../lib/asry/treasury-usdt-to-usdc.cjs");

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  const wantsHelp = args[0] === "-h" || args[0] === "--help";
  if (wantsHelp) {
    console.log(`
Usage: node scripts/run-treasury-usdt-to-usdc.cjs [USDT amount] [--dry-run]

Default amount: ${TREASURY_TEST_STABLECOIN_AMOUNT} USDT (testing convention: 0.5 of whichever stable is under test).

Examples:
  node scripts/run-treasury-usdt-to-usdc.cjs
  node scripts/run-treasury-usdt-to-usdc.cjs --dry-run
  node scripts/run-treasury-usdt-to-usdc.cjs 2.0

Requires .env: SOLANA_PRIVATE_KEY, TREASURY_SOLANA_ADDRESS (must match keypair pubkey).
`);
    process.exit(0);
  }
  const amountStr =
    args[0] ||
    process.env.TREASURY_TEST_SWAP_USDT ||
    TREASURY_TEST_STABLECOIN_AMOUNT;

  const sk = process.env.SOLANA_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY_BASE58;
  const treasury = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  const keypair = keypairFromEnvBase58(sk);
  if (!keypair) {
    console.error("SOLANA_PRIVATE_KEY missing or invalid base58 secret key");
    process.exit(1);
  }
  if (!treasury) {
    console.error("TREASURY_SOLANA_ADDRESS missing in .env");
    process.exit(1);
  }

  let atomic;
  try {
    atomic = usdtToAtomic(amountStr);
  } catch (e) {
    console.error("Invalid amount:", e.message);
    process.exit(1);
  }
  if (atomic <= 0n) {
    console.error("Amount must be positive");
    process.exit(1);
  }

  console.log("Treasury:", treasury);
  console.log("Signer pubkey:", keypair.publicKey.toBase58());
  console.log("USDT amount:", amountStr, "(atomic:", atomic.toString() + ")");

  try {
    const out = await swapTreasuryUsdtToUsdc({
      treasuryAddress: treasury,
      signerKeypair: keypair,
      amountUsdtAtomic: atomic,
      rpcUrl: process.env.SOLANA_RPC_URL,
      dryRun,
    });
    if (out.dryRun) {
      console.log("\n[DRY RUN] Signed tx (base64, first 80 chars):", (out.signedTxBase64 || "").slice(0, 80) + "...");
      console.log("Not broadcast.");
    } else {
      console.log("\nSubmitted:", out.signature);
      console.log("Explorer:", out.explorerUrl);
    }
    if (out.expectedUsdcAtomic != null) {
      console.log("Estimated USDC out (atomic, 6 dp):", out.expectedUsdcAtomic);
    }
  } catch (e) {
    console.error(e.code || "ERROR", e.message);
    if (e.details && process.env.DEBUG_LIFI) console.error(JSON.stringify(e.details, null, 2));
    process.exit(1);
  }
}

main();
