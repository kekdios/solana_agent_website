#!/usr/bin/env node
/**
 * Daily ABSR reserve sync: ensure ABSR supply = BTC reserve balance (1 sat : 1 ABSR).
 * Compares the Bitcoin reserve address balance (from BTC_PRIVATE_KEY_WIF or ABSR_BTC_RESERVE_ADDRESS)
 * to the on-chain ABSR token supply. If reserve has more sats than current ABSR supply,
 * mints the difference to the treasury (TREASURY_SOLANA_ADDRESS).
 *
 * Run with env from .env or /etc/solana-agent-website/secrets. Use run-daily-absr-mint.sh
 * or cron to run once per day.
 *
 * Env: BTC_PRIVATE_KEY_WIF (or ABSR_BTC_RESERVE_ADDRESS), SOLANA_PRIVATE_KEY,
 *      TREASURY_SOLANA_ADDRESS, SOLANA_RPC_URL, ABSR_MINT_ADDRESS (optional).
 * Test mode: set TEST_MINT_ABSR=100 to mint exactly that amount (skips reserve check; for local testing only).
 */

const { Keypair, Connection, PublicKey } = require("@solana/web3.js");
const { getMint, getOrCreateAssociatedTokenAccount, mintTo } = require("@solana/spl-token");
const bs58 = require("bs58");
const bitcoin = require("bitcoinjs-lib");

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const ABSR_MINT_ADDRESS = (process.env.ABSR_MINT_ADDRESS || "").trim() || "BvtyqwRSgrKjX3jUfR7Sq5XmuVKrPEcSTDbLmTCstP1E";
const TREASURY = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
/** Minimum SOL (lamports) the signer must have to pay for the mint transaction (~0.00001 SOL). */
const MIN_SOL_FOR_MINT_LAMPORTS = Number(process.env.MIN_SOL_FOR_MINT_LAMPORTS) || 15_000;
/** If set, mint exactly this many ABSR (skips reserve/supply check; for testing only). */
const TEST_MINT_ABSR = process.env.TEST_MINT_ABSR != null && process.env.TEST_MINT_ABSR !== "" ? Math.max(0, Math.floor(Number(process.env.TEST_MINT_ABSR))) : null;


function getBtcKey() {
  const wif = process.env.BTC_PRIVATE_KEY_WIF || process.env.BTC_PRIVATE_KEY;
  if (!wif || !wif.trim()) return null;
  try {
    return bitcoin.ECPair.fromWIF(wif.trim(), bitcoin.networks.bitcoin);
  } catch (_) {
    return null;
  }
}

function getBtcAddress(keyPair) {
  if (!keyPair) return null;
  const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.bitcoin });
  return address;
}

function getReserveBtcAddress() {
  const override = (process.env.ABSR_BTC_RESERVE_ADDRESS || "").trim();
  if (override) return override;
  const key = getBtcKey();
  return key ? getBtcAddress(key) : null;
}

async function fetchBtcBalanceSats(address) {
  if (!address) return null;
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const funded = Number(data.chain_stats?.funded_txo_sum ?? 0);
    const spent = Number(data.chain_stats?.spent_txo_sum ?? 0);
    return Math.round((funded - spent));
  } catch (_) {
    return null;
  }
}

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
  const isTestMint = TEST_MINT_ABSR != null && TEST_MINT_ABSR > 0;
  if (!TREASURY) {
    console.error("mint-absr-to-reserve: TREASURY_SOLANA_ADDRESS is required.");
    process.exit(1);
  }
  const signer = getSolanaKeypair();
  if (!signer) {
    console.error("mint-absr-to-reserve: SOLANA_PRIVATE_KEY is required (mint authority).");
    process.exit(1);
  }

  const conn = new Connection(SOLANA_RPC);
  const mintPubkey = new PublicKey(ABSR_MINT_ADDRESS);
  const treasuryPubkey = new PublicKey(TREASURY);

  let toMint;
  if (isTestMint) {
    toMint = TEST_MINT_ABSR;
    console.log("TEST_MINT_ABSR mode: minting exactly", toMint, "ABSR (no reserve check).");
  } else {
    const btcAddress = getReserveBtcAddress();
    if (!btcAddress) {
      console.error("mint-absr-to-reserve: BTC reserve address not set. Set BTC_PRIVATE_KEY_WIF or ABSR_BTC_RESERVE_ADDRESS.");
      process.exit(1);
    }
    const [reserveSats, mintInfo] = await Promise.all([
      fetchBtcBalanceSats(btcAddress),
      getMint(conn, mintPubkey),
    ]);
    if (reserveSats == null) {
      console.error("mint-absr-to-reserve: Could not fetch BTC balance for", btcAddress);
      process.exit(1);
    }
    const currentSupply = mintInfo && mintInfo.supply != null ? Number(mintInfo.supply) : 0;
    toMint = Math.max(0, Math.floor(reserveSats) - currentSupply);
    console.log("Reserve BTC address:", btcAddress);
    console.log("Reserve balance (sats):", reserveSats);
    console.log("ABSR current supply:", currentSupply);
    console.log("To mint:", toMint);
    if (toMint === 0) {
      console.log("No mint needed; ABSR supply already matches reserve.");
      return;
    }
  }

  const signerBalance = await conn.getBalance(signer.publicKey);
  if (signerBalance < MIN_SOL_FOR_MINT_LAMPORTS) {
    console.error(
      "mint-absr-to-reserve: Insufficient SOL in treasury/signer wallet for transaction fees. " +
        "Balance: " + (signerBalance / 1e9).toFixed(9) + " SOL; required at least " + (MIN_SOL_FOR_MINT_LAMPORTS / 1e9).toFixed(9) + " SOL."
    );
    process.exit(1);
  }

  const ata = await getOrCreateAssociatedTokenAccount(conn, signer, mintPubkey, treasuryPubkey);
  const sig = await mintTo(conn, signer, mintPubkey, ata.address, signer.publicKey, toMint);
  console.log("Minted", toMint, "ABSR to treasury. Signature:", sig);

}

main().catch((err) => {
  console.error("mint-absr-to-reserve:", err.message || err);
  process.exit(1);
});
