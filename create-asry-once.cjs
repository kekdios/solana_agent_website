#!/usr/bin/env node
/**
 * One-time script: create ASRY token (Agent Strategic Reserve Yield) on Solana.
 * Uses SOLANA_PRIVATE_KEY and TREASURY_SOLANA_ADDRESS from .env (or /etc/solana-agent-website/secrets on droplet).
 *
 * Token: Name "Agent Strategic Reserve Yield", Symbol "ASRY", 9 decimals, initial supply 10.
 * Creator = treasury. Authorities stay with signer (no revoke). Metaplex metadata is not created
 * on-chain by this script (add separately if desired).
 *
 * Run once from website/: node create-asry-once.cjs
 * On droplet: source /etc/solana-agent-website/secrets && node /var/www/solana_agent/create-asry-once.cjs
 */
const fs = require("fs");
const path = require("path");

// Load .env from script dir or parent
for (const dir of [__dirname, path.join(__dirname, "..")]) {
  const envPath = path.join(dir, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    break;
  }
}

const { Keypair, Connection, PublicKey } = require("@solana/web3.js");
const { createMint, getOrCreateAssociatedTokenAccount, mintTo } = require("@solana/spl-token");
const bs58 = require("bs58");

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TREASURY = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
const DECIMALS = 9;
const INITIAL_SUPPLY_RAW = 10n * 10n ** BigInt(DECIMALS); // 10 tokens

function getSolanaKeypair() {
  const b58 = process.env.SOLANA_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY_BASE58;
  if (!b58 || !b58.trim()) return null;
  try {
    const decode = (bs58 && bs58.default ? bs58.default : bs58).decode;
    const secret = decode(b58.trim());
    return Keypair.fromSecretKey(secret);
  } catch (_) {
    return null;
  }
}

async function main() {
  if (!TREASURY) {
    console.error("TREASURY_SOLANA_ADDRESS is required in .env or secrets.");
    process.exit(1);
  }
  const signer = getSolanaKeypair();
  if (!signer) {
    console.error("SOLANA_PRIVATE_KEY is required in .env or secrets.");
    process.exit(1);
  }

  const conn = new Connection(SOLANA_RPC);
  const mintKeypair = Keypair.generate();
  const creatorPubkey = new PublicKey(TREASURY);

  console.log("Creating ASRY mint and minting initial supply to", TREASURY, "...");

  const mintPubkey = await createMint(
    conn,
    signer,
    signer.publicKey,
    signer.publicKey,
    DECIMALS,
    mintKeypair
  );

  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    signer,
    mintPubkey,
    creatorPubkey
  );

  await mintTo(
    conn,
    signer,
    mintPubkey,
    ata.address,
    signer,
    INITIAL_SUPPLY_RAW
  );

  console.log("ASRY token created.");
  console.log("Mint address:", mintPubkey.toBase58());
  console.log("Creator (treasury) ATA:", ata.address.toBase58());
  console.log("Initial supply: 10 ASRY (", INITIAL_SUPPLY_RAW.toString(), "raw units )");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
