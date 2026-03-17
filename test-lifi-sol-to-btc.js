#!/usr/bin/env node
/**
 * Test LI.FI SOL → BTC flow (~0.05 SOL to reserve BTC address).
 * 1) Get quote from li.quest
 * 2) Deserialize transactionRequest.data, sign with SOLANA_PRIVATE_KEY, send to Solana
 * 3) Poll GET /v1/status until DONE or FAILED
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { Keypair, Connection, Transaction, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");

const LIFI_BASE = "https://li.quest/v1";
const FROM_CHAIN = "sol";
const TO_CHAIN = "btc";
const TO_BTC_ADDRESS = "16yEBGKD1jBFE2eRUchDJcpLLP3wLoD1Mz";
const AMOUNT_SOL = 0.02;
const FROM_AMOUNT_LAMPORTS = Math.floor(AMOUNT_SOL * 1e9);

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

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
  console.log("LI.FI test: SOL → BTC (0.02 SOL → reserve address)");
  console.log("toAddress:", TO_BTC_ADDRESS);
  console.log("fromAmount:", AMOUNT_SOL, "SOL =", FROM_AMOUNT_LAMPORTS, "lamports\n");

  const keypair = getSolanaKeypair();
  if (!keypair) {
    console.error("SOLANA_PRIVATE_KEY not set in .env");
    process.exit(1);
  }
  const fromAddress = keypair.publicKey.toBase58();
  console.log("fromAddress (reserve):", fromAddress);

  // 1) Get quote (use it immediately — Solana blockhash in tx expires in ~60–90s)
  const quoteUrl = `${LIFI_BASE}/quote?fromChain=${FROM_CHAIN}&toChain=${TO_CHAIN}&fromToken=SOL&toToken=BTC&fromAmount=${FROM_AMOUNT_LAMPORTS}&fromAddress=${encodeURIComponent(fromAddress)}&toAddress=${encodeURIComponent(TO_BTC_ADDRESS)}`;
  console.log("\n1) GET quote (fresh; blockhash expires in ~90s)...");
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    console.error("Quote failed:", quoteRes.status, await quoteRes.text());
    process.exit(1);
  }
  const quote = await quoteRes.json();
  const txReq = quote.transactionRequest;
  if (!txReq || !txReq.data) {
    console.error("No transactionRequest.data in quote:", JSON.stringify(quote).slice(0, 500));
    process.exit(1);
  }
  const estimate = quote.estimate || {};
  console.log("   toAmount (sats):", estimate.toAmount);
  console.log("   toAmountMin (sats):", estimate.toAmountMin);
  console.log("   tool:", (quote.toolDetails || {}).name || quote.tool);

  const txBuffer = Buffer.from(txReq.data, "base64");
  if (txBuffer.length === 0) {
    console.error("Empty transaction data");
    process.exit(1);
  }
  const u8 = new Uint8Array(txBuffer);
  let signedTxBuffer;
  try {
    const versionedTx = VersionedTransaction.deserialize(u8);
    versionedTx.sign([keypair]);
    signedTxBuffer = Buffer.from(versionedTx.serialize());
    console.log("   (versioned transaction)");
  } catch (_) {
    try {
      const legacyTx = Transaction.from(txBuffer);
      legacyTx.sign(keypair);
      signedTxBuffer = Buffer.from(legacyTx.serialize());
      console.log("   (legacy transaction)");
    } catch (e) {
      console.error("Failed to deserialize/sign transaction:", e.message);
      process.exit(1);
    }
  }

  const conn = new Connection(SOLANA_RPC);
  console.log("\n2) Sending signed transaction to Solana (skipPreflight to avoid extra RPC delay)...");
  const sig = await conn.sendRawTransaction(signedTxBuffer, { skipPreflight: true });
  console.log("   signature:", sig);

  // 3) Poll status
  const fromChainId = 1151111081099710;
  const toChainId = 20000000000001;
  const tool = quote.tool || "near";
  console.log("\n3) Polling LI.FI status (txHash=" + sig.slice(0, 16) + "...)...");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusUrl = `${LIFI_BASE}/status?txHash=${encodeURIComponent(sig)}&fromChain=${fromChainId}&toChain=${toChainId}&bridge=${encodeURIComponent(tool)}`;
    const statusRes = await fetch(statusUrl);
    if (!statusRes.ok) {
      console.log("   status request failed:", statusRes.status);
      continue;
    }
    const statusData = await statusRes.json();
    const status = statusData.status;
    console.log("   [" + (i + 1) + "] status:", status, statusData.substatus || "");
    if (status === "DONE") {
      console.log("\nDone. Transfer completed.");
      console.log("Receiving tx:", statusData.receivingTx || statusData);
      process.exit(0);
    }
    if (status === "FAILED") {
      console.error("\nFailed:", statusData);
      process.exit(1);
    }
  }
  console.log("\nTimeout waiting for DONE (still PENDING). Check https://explorer.li.fi for " + sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
