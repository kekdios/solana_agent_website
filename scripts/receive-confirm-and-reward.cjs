#!/usr/bin/env node
/**
 * Confirm receive (USDT swap or USDC deposit tx), then send sender $0.50 of ASRY @ $100/ASRY.
 *
 *   USDT:  node scripts/receive-confirm-and-reward.cjs USDT <sender_pubkey>
 *          node scripts/receive-confirm-and-reward.cjs USDT 0.5 <sender_pubkey>
 *   USDC:  node scripts/receive-confirm-and-reward.cjs USDC <amount> <sender_pubkey> <deposit_tx_sig>
 *
 *   --skip-reward   confirm only
 *   --dry-run       USDT: quote only (no swap/reward)
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

const { receiveStableConfirmAndReward } = require("../lib/asry/receive-confirm-and-reward.cjs");
const { keypairFromEnvBase58 } = require("../lib/asry/receive-stable-to-treasury.cjs");
const { TREASURY_TEST_STABLECOIN_AMOUNT } = require("../lib/asry/treasury-usdt-to-usdc-jupiter.cjs");

async function main() {
  const argv = process.argv.slice(2);
  const skipReward = argv.includes("--skip-reward");
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((a) => !a.startsWith("--"));

  if (args[0] === "-h" || !args[0]) {
    console.log(`
USDT:  node scripts/receive-confirm-and-reward.cjs USDT [amount] <sender_pubkey>
USDC:  node scripts/receive-confirm-and-reward.cjs USDC <amount> <sender_pubkey> <deposit_tx_sig>

Default USDT amount: ${TREASURY_TEST_STABLECOIN_AMOUNT}
Reward: $0.50 ASRY @ $100/ASRY (see lib/asry/asry-price.cjs)
Env: ASRY_MINT_ADDRESS (unless --skip-reward)
`);
    process.exit(args[0] === "-h" ? 0 : 1);
  }

  const asset = args[0].toUpperCase();
  let amount;
  let sender;
  let depositSig;

  if (asset === "USDT") {
    if (args.length === 2) {
      amount = TREASURY_TEST_STABLECOIN_AMOUNT;
      sender = args[1];
    } else if (args.length === 3) {
      amount = args[1];
      sender = args[2];
    } else {
      console.error("USDT: USDT [amount] <sender_pubkey>");
      process.exit(1);
    }
  } else if (asset === "USDC") {
    if (args.length !== 4) {
      console.error("USDC: USDC <amount> <sender_pubkey> <deposit_tx_signature>");
      process.exit(1);
    }
    amount = args[1];
    sender = args[2];
    depositSig = args[3];
  } else {
    console.error("First arg must be USDT or USDC");
    process.exit(1);
  }

  const keypair = keypairFromEnvBase58(process.env.SOLANA_PRIVATE_KEY);
  const treasury = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  if (!keypair || !treasury) {
    console.error("SOLANA_PRIVATE_KEY and TREASURY_SOLANA_ADDRESS required");
    process.exit(1);
  }

  try {
    const out = await receiveStableConfirmAndReward({
      asset,
      amount,
      senderPubkey: sender,
      treasuryAddress: treasury,
      signerKeypair: keypair,
      rpcUrl: process.env.SOLANA_RPC_URL,
      depositTxSignature: depositSig,
      skipReward,
      dryRun,
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (e.partialResult) console.log(JSON.stringify(e.partialResult, null, 2));
    console.error(e.code || "ERROR", e.message);
    process.exit(1);
  }
}

main();
