#!/usr/bin/env node
/**
 * Treasury USDT → USDC via Jupiter (receiving / normalization path).
 * Prefer over LI.FI when public-mempool spam targeted the other route.
 *
 * Env: SOLANA_PRIVATE_KEY, TREASURY_SOLANA_ADDRESS (same pubkey), SOLANA_RPC_URL (optional)
 * Optional: JUPITER_PRIORITY_LEVEL=veryHigh JUPITER_PRIORITY_MAX_LAMPORTS=2000000
 *           JUPITER_SLIPPAGE_BPS=50  JUPITER_ONLY_DIRECT=true (default)
 *
 * Usage:
 *   node scripts/run-treasury-usdt-to-usdc-jupiter.cjs
 *   node scripts/run-treasury-usdt-to-usdc-jupiter.cjs 0.5 --dry-run
 */
const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const {
  swapTreasuryUsdtToUsdcJupiter,
  keypairFromEnvBase58,
  usdtToAtomic,
  TREASURY_TEST_STABLECOIN_AMOUNT,
} = require("../lib/asry/treasury-usdt-to-usdc-jupiter.cjs");

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`
Treasury USDT → USDC (Jupiter, direct routes).

  node scripts/run-treasury-usdt-to-usdc-jupiter.cjs [amount] [--dry-run]

Default amount: ${TREASURY_TEST_STABLECOIN_AMOUNT} USDT
`);
    process.exit(0);
  }
  const amountStr =
    args[0] || process.env.TREASURY_TEST_SWAP_USDT || TREASURY_TEST_STABLECOIN_AMOUNT;
  const onlyDirect =
    process.env.JUPITER_ONLY_DIRECT !== "false" &&
    process.env.JUPITER_ONLY_DIRECT !== "0";

  const sk = process.env.SOLANA_PRIVATE_KEY;
  const treasury = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  const keypair = keypairFromEnvBase58(sk);
  if (!keypair) {
    console.error("SOLANA_PRIVATE_KEY missing or invalid");
    process.exit(1);
  }
  if (!treasury) {
    console.error("TREASURY_SOLANA_ADDRESS missing");
    process.exit(1);
  }

  const atomic = usdtToAtomic(amountStr);
  console.log("Jupiter path | onlyDirectRoutes:", onlyDirect);
  console.log("Treasury:", treasury);
  console.log("USDT amount:", amountStr, "atomic:", atomic.toString());

  try {
    const out = await swapTreasuryUsdtToUsdcJupiter({
      treasuryAddress: treasury,
      signerKeypair: keypair,
      amountUsdtAtomic: atomic,
      rpcUrl: process.env.SOLANA_RPC_URL,
      onlyDirectRoutes: onlyDirect,
      dryRun,
    });
    if (out.dryRun) {
      console.log("[DRY RUN] signed tx length:", (out.signedTxBase64 || "").length);
      console.log("Route:", out.routeLabel);
    } else {
      console.log("Signature:", out.signature);
      console.log("Explorer:", out.explorerUrl);
      console.log("Route:", out.routeLabel);
      console.log("Est. USDC out (atomic):", out.expectedOutAtomic);
    }
  } catch (e) {
    console.error(e.code || "ERROR", e.message);
    process.exit(1);
  }
}

main();
