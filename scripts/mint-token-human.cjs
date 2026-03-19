#!/usr/bin/env node
/**
 * Mint a human-readable amount of a token to a destination (default: ASRY to treasury).
 * Uses SOLANA_PRIVATE_KEY as mint authority.
 *
 *   node scripts/mint-token-human.cjs                    # 100 ASRY to TREASURY_SOLANA_ADDRESS
 *   node scripts/mint-token-human.cjs 200                  # 200 human units to treasury
 *   node scripts/mint-token-human.cjs 100 <destination>    # 100 to destination pubkey
 *   node scripts/mint-token-human.cjs 100 <destination> <mint_address>
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

const { mintTokenHuman } = require("../lib/asry/mint-token-human.cjs");
const { keypairFromEnvBase58 } = require("../lib/asry/receive-stable-to-treasury.cjs");
const { ASRY_MINT_TREASURY_MAINNET } = require("../lib/asry/asry-price.cjs");

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const amountHuman = args.length >= 1 ? Number(args[0]) : 100;
  const destination =
    args.length >= 2
      ? args[1].trim()
      : (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  const mintAddress =
    args.length >= 3
      ? args[2].trim()
      : (process.env.ASRY_MINT_ADDRESS || "").trim() || ASRY_MINT_TREASURY_MAINNET;

  const keypair = keypairFromEnvBase58(process.env.SOLANA_PRIVATE_KEY);
  if (!keypair) {
    console.error("SOLANA_PRIVATE_KEY is required.");
    process.exit(1);
  }
  if (!destination) {
    console.error("Destination required: set TREASURY_SOLANA_ADDRESS or pass <destination>.");
    process.exit(1);
  }

  const result = await mintTokenHuman({
    mintAddress,
    amountHuman,
    destinationOwner: destination,
    signerKeypair: keypair,
    rpcUrl: process.env.SOLANA_RPC_URL,
  });

  console.log("Minted", amountHuman, "tokens to", destination);
  console.log("Signature:", result.signature);
  console.log("Explorer:", result.explorerUrl);
  console.log("Amount (atomic):", result.amountAtomic);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
