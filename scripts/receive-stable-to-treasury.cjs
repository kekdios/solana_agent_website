#!/usr/bin/env node
/**
 * One receiving entrypoint: USDT or USDC → normalized at treasury (USDC).
 *
 *   USDT: swap treasury USDT → USDC (Jupiter).
 *   USDC: confirm treasury holds ≥ amount (already correct asset).
 *
 * Usage:
 *   node scripts/receive-stable-to-treasury.cjs USDT 0.5
 *   node scripts/receive-stable-to-treasury.cjs USDC 1.0
 *   node scripts/receive-stable-to-treasury.cjs USDT 0.5 --dry-run
 *   node scripts/receive-stable-to-treasury.cjs USDC 0.1 --skip-balance-check
 */
const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
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
  receiveStableToTreasury,
  keypairFromEnvBase58,
} = require("../lib/asry/receive-stable-to-treasury.cjs");
const { TREASURY_TEST_STABLECOIN_AMOUNT } = require("../lib/asry/treasury-usdt-to-usdc-jupiter.cjs");

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const skipBal = argv.includes("--skip-balance-check");
  const args = argv.filter(
    (a) => a !== "--dry-run" && a !== "--skip-balance-check"
  );

  if (args[0] === "-h" || args[0] === "--help" || args.length < 1) {
    console.log(`
Receive stables at treasury (single function).

  node scripts/receive-stable-to-treasury.cjs <USDT|USDC> [amount] [--dry-run] [--skip-balance-check]

  USDT <amt>  — swap USDT at treasury → USDC via Jupiter.
  USDC <amt>  — confirm SPL USDC deposit (plain transfer to treasury USDC ATA; never Jupiter).

Default amount: ${TREASURY_TEST_STABLECOIN_AMOUNT}

Env: SOLANA_PRIVATE_KEY, TREASURY_SOLANA_ADDRESS (same pubkey).
`);
    process.exit(args[0] === "-h" || args[0] === "--help" ? 0 : 1);
  }

  const asset = args[0];
  const amountStr =
    args[1] ||
    (String(asset).toUpperCase() === "USDT"
      ? process.env.TREASURY_TEST_SWAP_USDT
      : process.env.TREASURY_TEST_SWAP_USDC) ||
    TREASURY_TEST_STABLECOIN_AMOUNT;

  const keypair = keypairFromEnvBase58(process.env.SOLANA_PRIVATE_KEY);
  const treasury = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  if (!keypair || !treasury) {
    console.error("Need SOLANA_PRIVATE_KEY and TREASURY_SOLANA_ADDRESS");
    process.exit(1);
  }

  try {
    const out = await receiveStableToTreasury({
      asset,
      amount: amountStr,
      treasuryAddress: treasury,
      signerKeypair: keypair,
      rpcUrl: process.env.SOLANA_RPC_URL,
      dryRun,
      skipBalanceCheck: skipBal,
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(e.code || "ERROR", e.message);
    process.exit(1);
  }
}

main();
