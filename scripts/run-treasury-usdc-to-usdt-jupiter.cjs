#!/usr/bin/env node
/**
 * Treasury USDC → USDT via Jupiter (test 0.5 USDC path).
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
  swapTreasuryUsdcToUsdtJupiter,
  keypairFromEnvBase58,
  stableToAtomic,
  TREASURY_TEST_STABLECOIN_AMOUNT,
} = require("../lib/asry/treasury-usdt-to-usdc-jupiter.cjs");

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`
Treasury USDC → USDT (Jupiter).

  node scripts/run-treasury-usdc-to-usdt-jupiter.cjs [amount] [--dry-run]
  Default: ${TREASURY_TEST_STABLECOIN_AMOUNT} USDC
`);
    process.exit(0);
  }
  const amountStr =
    args[0] || process.env.TREASURY_TEST_SWAP_USDC || TREASURY_TEST_STABLECOIN_AMOUNT;
  const onlyDirect =
    process.env.JUPITER_ONLY_DIRECT !== "false" &&
    process.env.JUPITER_ONLY_DIRECT !== "0";

  const keypair = keypairFromEnvBase58(process.env.SOLANA_PRIVATE_KEY);
  const treasury = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  if (!keypair || !treasury) {
    console.error("SOLANA_PRIVATE_KEY and TREASURY_SOLANA_ADDRESS required");
    process.exit(1);
  }

  const atomic = stableToAtomic(amountStr);
  console.log("Jupiter USDC→USDT | onlyDirectRoutes:", onlyDirect);
  console.log("Treasury:", treasury);
  console.log("USDC amount:", amountStr, "atomic:", atomic.toString());

  try {
    const out = await swapTreasuryUsdcToUsdtJupiter({
      treasuryAddress: treasury,
      signerKeypair: keypair,
      amountUsdcAtomic: atomic,
      rpcUrl: process.env.SOLANA_RPC_URL,
      onlyDirectRoutes: onlyDirect,
      dryRun,
    });
    if (out.dryRun) {
      console.log("[DRY RUN] route:", out.routeLabel);
    } else {
      console.log("Signature:", out.signature);
      console.log("Explorer:", out.explorerUrl);
      console.log("Route:", out.routeLabel);
      console.log("Est. USDT out (atomic):", out.expectedOutAtomic);
    }
  } catch (e) {
    console.error(e.code || "ERROR", e.message);
    process.exit(1);
  }
}

main();
