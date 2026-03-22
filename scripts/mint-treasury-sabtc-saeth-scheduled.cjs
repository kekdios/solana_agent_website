#!/usr/bin/env node
/**
 * Mint fixed SABTC + SAETH amounts to TREASURY_SOLANA_ADDRESS (scheduled job).
 * Amounts and interval are documented in treasury-mint-schedule.json (keep in sync with treasury page).
 *
 * Env: SOLANA_PRIVATE_KEY, TREASURY_SOLANA_ADDRESS (must match signer; signer must be mint authority).
 * Optional: SOLANA_RPC_URL, SABTC_MINT_ADDRESS, SAETH_MINT_ADDRESS (defaults match api-server.cjs).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCHEDULE_PATH = path.join(ROOT, "treasury-mint-schedule.json");

function loadDotEnv() {
  const candidates = [
    path.join(ROOT, ".env"),
    path.join(ROOT, "..", ".env"),
    "/etc/solana-agent-website/secrets",
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
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
}

loadDotEnv();

const { mintTokenHuman } = require("../lib/asry/mint-token-human.cjs");
const { keypairFromEnvBase58 } = require("../lib/asry/receive-stable-to-treasury.cjs");

const DEFAULT_SABTC = (process.env.SABTC_MINT_ADDRESS || "").trim() || "2kR1UKhrXq6Hef6EukLyzdD5ahcezRqwURKdtCJx2Ucy";
const DEFAULT_SAETH = (process.env.SAETH_MINT_ADDRESS || "").trim() || "AhyZRrDrN3apDzZqdRHtpxWmnqYDdL8VnJ66ip1KbiDS";

async function main() {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_PATH, "utf8"));
  const sabtcAmt = Number(schedule.amounts?.sabtc);
  const saethAmt = Number(schedule.amounts?.saeth);
  if (!Number.isFinite(sabtcAmt) || sabtcAmt <= 0 || !Number.isFinite(saethAmt) || saethAmt <= 0) {
    throw new Error("Invalid amounts in treasury-mint-schedule.json");
  }

  const keypair = keypairFromEnvBase58(process.env.SOLANA_PRIVATE_KEY);
  if (!keypair) throw new Error("SOLANA_PRIVATE_KEY is required");

  const treasury = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
  if (!treasury) throw new Error("TREASURY_SOLANA_ADDRESS is required");

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  const stamp = new Date().toISOString();
  console.log(JSON.stringify({ at: stamp, event: "treasury_mint_start", sabtc: sabtcAmt, saeth: saethAmt }));

  const r1 = await mintTokenHuman({
    mintAddress: DEFAULT_SABTC,
    amountHuman: sabtcAmt,
    destinationOwner: treasury,
    signerKeypair: keypair,
    rpcUrl,
  });
  console.log(JSON.stringify({ at: stamp, token: "SABTC", signature: r1.signature }));

  const r2 = await mintTokenHuman({
    mintAddress: DEFAULT_SAETH,
    amountHuman: saethAmt,
    destinationOwner: treasury,
    signerKeypair: keypair,
    rpcUrl,
  });
  console.log(JSON.stringify({ at: stamp, token: "SAETH", signature: r2.signature }));

  console.log(JSON.stringify({ at: stamp, event: "treasury_mint_done" }));
}

main().catch((err) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), event: "treasury_mint_error", error: err.message || String(err) }));
  process.exit(1);
});
