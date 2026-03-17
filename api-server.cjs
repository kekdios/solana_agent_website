/**
 * Proof-of-reserves API for Solana Agent website.
 * Env: BTC_PRIVATE_KEY_WIF, SOLANA_PRIVATE_KEY, DATABASE_URL (optional). SOL→BTC swap via LI.FI (no API key required).
 */
const http = require("http");
const { Keypair, Connection, PublicKey, Transaction, VersionedTransaction, SystemProgram } = require("@solana/web3.js");
const { createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, AuthorityType, getMint } = require("@solana/spl-token");
const bs58 = require("bs58");
const bitcoin = require("bitcoinjs-lib");
const bitcoinMessage = require("bitcoinjs-message");
const nacl = require("tweetnacl");

const PORT = Number(process.env.API_PORT) || 3001;

let openapiSpec = null;
try { openapiSpec = require("./openapi.json"); } catch (_) {}

/** Send structured error for agents (error_code, error, optional action). Keeps "error" for backward compatibility. */
function sendError(res, status, errorCode, message, action) {
  res.writeHead(status);
  const body = { error_code: errorCode, error: message };
  if (action != null) body.action = action;
  res.end(JSON.stringify(body));
}
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const ABSR_MINT_ADDRESS = (process.env.ABSR_MINT_ADDRESS || "").trim() || "BvtyqwRSgrKjX3jUfR7Sq5XmuVKrPEcSTDbLmTCstP1E";
const PROOF_MESSAGE_PREFIX = "Solana Agent proof of reserves";
const LIFI_BASE = "https://li.quest/v1";
const LIFI_FROM_CHAIN = "1151111081099710";
const LIFI_TO_CHAIN = "20000000000001";
const SOL_FEE_RESERVE_LAMPORTS = 10000;
/** Minimum SOL amount for LI.FI SOL→BTC (conservative; quote may allow slightly less). */
const LIFI_MIN_SOL = 0.001;

let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require("pg");
    const connectionString = (process.env.DATABASE_URL || "").trim();
    if (connectionString) pgPool = new Pool({ connectionString });
  } catch (_) {}
}

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

async function fetchBtcBalance(address) {
  if (!address) return null;
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const funded = Number(data.chain_stats?.funded_txo_sum ?? 0);
    const spent = Number(data.chain_stats?.spent_txo_sum ?? 0);
    return (funded - spent) / 1e8;
  } catch (_) {
    return null;
  }
}

async function fetchSolBalance(connection, publicKey) {
  if (!connection || !publicKey) return null;
  try {
    const bal = await connection.getBalance(publicKey);
    return bal / 1e9;
  } catch (_) {
    return null;
  }
}

function signBitcoinMessage(message, keyPair) {
  if (!keyPair) return null;
  try {
    const sig = bitcoinMessage.sign(message, keyPair.privateKey, keyPair.compressed);
    return Buffer.isBuffer(sig) ? sig.toString("base64") : sig;
  } catch (_) {
    return null;
  }
}

function signSolanaMessage(message, keypair) {
  if (!keypair) return null;
  try {
    const msgBytes = Buffer.from(message, "utf8");
    const sig = nacl.sign.detached(msgBytes, keypair.secretKey);
    return Buffer.from(sig).toString("base64");
  } catch (_) {
    return null;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** LI.FI: get quote for SOL → BTC. Returns quote object or null on error. */
async function lifiQuote(fromAddress, toBtcAddress, fromAmountLamports) {
  const url = `${LIFI_BASE}/quote?fromChain=sol&toChain=btc&fromToken=SOL&toToken=BTC&fromAmount=${fromAmountLamports}&fromAddress=${encodeURIComponent(fromAddress)}&toAddress=${encodeURIComponent(toBtcAddress)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/** LI.FI: get transfer status by source tx hash. */
async function lifiStatus(txHash, tool = "near") {
  const url = `${LIFI_BASE}/status?txHash=${encodeURIComponent(txHash)}&fromChain=${LIFI_FROM_CHAIN}&toChain=${LIFI_TO_CHAIN}&bridge=${encodeURIComponent(tool)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function sendSolToAddress(connection, fromKeypair, toAddress, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports: Number(lamports),
    })
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromKeypair.publicKey;
  tx.sign(fromKeypair);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// Explorer: treasury, listing fee, and invoice (creation + 5% on estimated Solana fees)
const TREASURY_SOLANA_ADDRESS = (process.env.TREASURY_SOLANA_ADDRESS || "").trim();
const LISTING_FEE_SOL = Number(process.env.LISTING_FEE_SOL) || 0.1;
const ESTIMATED_CREATION_SOL = Number(process.env.ESTIMATED_CREATION_SOL) || 0.01;
const INVOICE_MARKUP_PERCENT = Number(process.env.INVOICE_MARKUP_PERCENT) || 5;
function invoiceFeeSol() {
  return Math.ceil(ESTIMATED_CREATION_SOL * (1 + INVOICE_MARKUP_PERCENT / 100) * 1e9) / 1e9;
}

/**
 * Create SPL mint, mint full supply to creator's ATA, optionally revoke mint/freeze authority.
 * Requires creator_address. Returns { mintAddress }.
 */
async function createSplTokenForInvoice(inv, payerKeypair) {
  const conn = new Connection(SOLANA_RPC);
  const creatorAddress = (inv.creator_address || "").trim();
  if (!creatorAddress) {
    throw new Error("creator_address is required to create SPL token");
  }
  const decimals = Math.min(9, Math.max(0, Number(inv.decimals) || 9));
  const supplyStr = String(inv.supply || "0").replace(/,/g, "");
  const supplyRaw = BigInt(supplyStr); // supply is in smallest units (raw)
  if (supplyRaw <= 0n) {
    throw new Error("Token supply must be positive");
  }
  const mintKeypair = Keypair.generate();
  const freezeAuthority = inv.revoke_freeze_authority ? null : payerKeypair.publicKey;

  const mintPubkey = await createMint(
    conn,
    payerKeypair,
    payerKeypair.publicKey,
    freezeAuthority,
    decimals,
    mintKeypair
  );

  const ownerPubkey = new PublicKey(creatorAddress);
  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    payerKeypair,
    mintPubkey,
    ownerPubkey
  );

  await mintTo(
    conn,
    payerKeypair,
    mintPubkey,
    ata.address,
    payerKeypair,
    supplyRaw
  );

  if (inv.revoke_mint_authority) {
    await setAuthority(
      conn,
      payerKeypair,
      mintPubkey,
      payerKeypair.publicKey,
      AuthorityType.MintTokens,
      null
    );
  }

  return { mintAddress: mintPubkey.toBase58() };
}

async function verifySolPaymentToTreasury(txSignature, requiredLamports) {
  if (!TREASURY_SOLANA_ADDRESS || requiredLamports <= 0) return false;
  const conn = new Connection(SOLANA_RPC);
  const tx = await conn.getParsedTransaction(txSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta || tx.meta.err) return false;
  const treasuryPubkey = TREASURY_SOLANA_ADDRESS;
  function checkInstruction(ix) {
    if (ix.program !== "system" || ix.parsed?.type !== "transfer") return false;
    const dest = ix.parsed?.info?.destination;
    const lamports = ix.parsed?.info?.lamports;
    const amount = typeof lamports === "number" ? lamports : Number(lamports);
    return dest === treasuryPubkey && !Number.isNaN(amount) && amount >= requiredLamports;
  }
  const instructions = tx.transaction?.message?.instructions || [];
  for (const ix of instructions) {
    if (checkInstruction(ix)) return true;
  }
  const inner = tx.meta?.innerInstructions || [];
  for (const group of inner) {
    for (const ix of group.instructions || []) {
      if (checkInstruction(ix)) return true;
    }
  }
  return false;
}

let absrListedEnsureDone = false;
/** Ensure ABSR token exists in tokens table and is listed (confirmed) so it appears in Token Repository. @param opts.rethrow - if true, rethrow on error so caller can return it (e.g. debug endpoint). */
async function ensureAbsrListed(opts = {}) {
  if (!pgPool || absrListedEnsureDone) return;
  const creatorAddress = (TREASURY_SOLANA_ADDRESS || "").trim() || null;
  try {
    const existing = await pgPool.query("SELECT id FROM tokens WHERE mint_address = $1", [ABSR_MINT_ADDRESS]);
    let tokenId;
    if (existing.rows.length > 0) {
      tokenId = existing.rows[0].id;
    } else {
      const ins = await pgPool.query(
        `INSERT INTO tokens (name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          "Agent Bitcoin Strategic Reserve",
          "ABSR",
          0,
          "10000",
          "1 satoshi - 1 ABSR",
          false,
          false,
          false,
          true,
          ABSR_MINT_ADDRESS,
          creatorAddress,
        ]
      );
      tokenId = ins.rows[0].id;
    }
    await pgPool.query(
      `INSERT INTO listing_requests (token_id, fee_sol, status, confirmed_at) VALUES ($1, 0, 'confirmed', NOW())
       ON CONFLICT (token_id) DO UPDATE SET status = 'confirmed', confirmed_at = COALESCE(listing_requests.confirmed_at, NOW())`,
      [tokenId]
    );
    absrListedEnsureDone = true;
  } catch (e) {
    const msg = e.message || String(e);
    const code = e.code || "";
    const detail = e.detail || "";
    console.warn("ensureAbsrListed:", msg, code ? `(${code})` : "", detail || "");
    if (opts.rethrow) throw e;
  }
}

const server = http.createServer(async (req, res) => {
  let path = "/";
  let url;
  try {
    const base = `http://${(req.headers.host || "localhost").trim()}`;
    url = new URL((req.url || "/").trim(), base);
    path = url.pathname;
  } catch (_) {
    const raw = (req.url || "/").trim();
    path = raw.includes("?") ? raw.slice(0, raw.indexOf("?")) : raw;
    url = { searchParams: new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "") };
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (path === "/api/openapi.json" && req.method === "GET") {
    if (openapiSpec) {
      res.writeHead(200);
      res.end(JSON.stringify(openapiSpec));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error_code: "NOT_FOUND", error: "OpenAPI spec not available" }));
    }
    return;
  }

  if (path === "/api/reserves" && req.method === "GET") {
    const btcKey = getBtcKey();
    const solKey = getSolanaKeypair();
    const btcAddress = getBtcAddress(btcKey);
    const solAddress = solKey ? solKey.publicKey.toBase58() : null;

    let btcBalance = null;
    let solBalance = null;
    if (btcAddress) btcBalance = await fetchBtcBalance(btcAddress);
    if (solKey) {
      const { Connection } = require("@solana/web3.js");
      const conn = new Connection(SOLANA_RPC);
      solBalance = await fetchSolBalance(conn, solKey.publicKey);
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        bitcoin: btcAddress
          ? { address: btcAddress, balanceBtc: btcBalance, balanceSat: btcBalance != null ? Math.round(btcBalance * 1e8) : null }
          : { address: null, balanceBtc: null, balanceSat: null },
        solana: solAddress
          ? { address: solAddress, balanceSol: solBalance }
          : { address: null, balanceSol: null },
      })
    );
    return;
  }

  if (path === "/api/proof" && req.method === "GET") {
    const date = new Date().toISOString().slice(0, 10);
    const message = `${PROOF_MESSAGE_PREFIX} - ${date}`;

    const btcKey = getBtcKey();
    const solKey = getSolanaKeypair();
    const btcAddress = getBtcAddress(btcKey);
    const solAddress = solKey ? solKey.publicKey.toBase58() : null;

    const btcSignature = signBitcoinMessage(message, btcKey);
    const solSignature = signSolanaMessage(message, solKey);

    res.writeHead(200);
    res.end(
      JSON.stringify({
        message,
        timestamp: date,
        bitcoin: btcAddress ? { address: btcAddress, signature: btcSignature } : { address: null, signature: null },
        solana: solAddress ? { address: solAddress, signature: solSignature } : { address: null, signature: null },
      })
    );
    return;
  }

  // Recent transactions for Proof of Reserves page (most recent first; frontend paginates 10 per page)
  if (path === "/api/transactions/bitcoin" && req.method === "GET") {
    const btcAddress = getBtcAddress(getBtcKey());
    if (!btcAddress) {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
      return;
    }
    try {
      const txs = [];
      let url = `https://blockstream.info/api/address/${btcAddress}/txs/chain`;
      for (let page = 0; page < 4; page++) {
        const resB = await fetch(url);
        if (!resB.ok) break;
        const list = await resB.json();
        if (!Array.isArray(list) || list.length === 0) break;
        for (const tx of list) {
          txs.push({
            txid: tx.txid,
            blockTime: tx.status?.block_time ?? null,
            blockHeight: tx.status?.block_height ?? null,
          });
        }
        if (list.length < 25) break;
        url = `https://blockstream.info/api/address/${btcAddress}/txs/chain/${list[list.length - 1].txid}`;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: txs.slice(0, 100) }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
    }
    return;
  }

  if (path === "/api/transactions/solana" && req.method === "GET") {
    const solKey = getSolanaKeypair();
    if (!solKey) {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
      return;
    }
    try {
      const { Connection } = require("@solana/web3.js");
      const conn = new Connection(SOLANA_RPC);
      const sigs = await conn.getSignaturesForAddress(solKey.publicKey, { limit: 100 });
      const transactions = sigs.map((s) => ({
        signature: s.signature,
        blockTime: s.blockTime,
        err: s.err ?? null,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ transactions }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
    }
    return;
  }

  // ABSR tab: summary (BTC/SOL prices from Hyperliquid; ABSR supply = reserve BTC sats, 1:1; on-chain token supply)
  if (path === "/api/arbitrage/summary" && req.method === "GET") {
    let btcPriceUsd = null;
    let solPriceUsd = null;
    try {
      const r = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "allMids" }),
      });
      if (r.ok) {
        const mids = await r.json();
        if (mids && typeof mids === "object") {
          if (mids.BTC != null) btcPriceUsd = Number(mids.BTC);
          if (mids.SOL != null) solPriceUsd = Number(mids.SOL);
        }
      }
    } catch (_) {}
    let absrSupplySats = 0;
    let absrSupplyUsd = 0;
    const btcKey = getBtcKey();
    const btcAddress = getBtcAddress(btcKey);
    if (btcAddress) {
      const btcBalance = await fetchBtcBalance(btcAddress);
      if (btcBalance != null) {
        absrSupplySats = Math.round(btcBalance * 1e8);
        absrSupplyUsd = btcPriceUsd != null ? (absrSupplySats / 1e8) * btcPriceUsd : 0;
      }
    }
    let absrTokenSupply = null;
    try {
      const conn = new Connection(SOLANA_RPC);
      const mintInfo = await getMint(conn, new PublicKey(ABSR_MINT_ADDRESS));
      if (mintInfo && mintInfo.supply != null) absrTokenSupply = String(mintInfo.supply);
    } catch (_) {}
    res.writeHead(200);
    res.end(
      JSON.stringify({
        btcPriceUsd,
        solPriceUsd,
        absrSupplySats,
        absrSupplyUsd,
        absrTokenSupply,
      })
    );
    return;
  }

  // Exchanges tab: from Postgres swap_transactions
  if (path === "/api/exchanges/transactions" && req.method === "GET") {
    if (pgPool) {
      try {
        const q = await pgPool.query(
          "SELECT changenow_id AS id, sol_amount AS \"solAmount\", btc_sats AS \"btcSats\", solana_signature AS signature, created_at AS \"blockTime\" FROM swap_transactions ORDER BY created_at DESC LIMIT 100"
        );
        const transactions = q.rows.map((r) => ({
          signature: r.signature,
          txId: r.id,
          solAmount: r.solAmount != null ? Number(r.solAmount) : null,
          btcSats: r.btcSats != null ? Number(r.btcSats) : null,
          blockTime: r.blockTime ? Math.floor(new Date(r.blockTime).getTime() / 1000) : null,
        }));
        res.writeHead(200);
        res.end(JSON.stringify({ transactions }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ transactions: [] }));
      }
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
    }
    return;
  }

  // Arbitrage tab: from Postgres arbitrage_transactions
  if (path === "/api/arbitrage/transactions" && req.method === "GET") {
    if (pgPool) {
      try {
        const q = await pgPool.query(
          "SELECT external_id, type, amount_sats, amount_usd, signature, created_at FROM arbitrage_transactions ORDER BY created_at DESC LIMIT 100"
        );
        const transactions = q.rows.map((r) => ({
          signature: r.signature,
          txId: r.external_id,
          type: r.type,
          amountSats: r.amount_sats != null ? Number(r.amount_sats) : null,
          amountUsd: r.amount_usd != null ? Number(r.amount_usd) : null,
          blockTime: r.created_at ? Math.floor(new Date(r.created_at).getTime() / 1000) : null,
        }));
        res.writeHead(200);
        res.end(JSON.stringify({ transactions }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ transactions: [] }));
      }
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
    }
    return;
  }

  // Swap SOL → BTC (LI.FI only): estimated BTC sats for a given SOL amount
  if (path === "/api/swap/estimate" && req.method === "GET") {
    const amountSol = url.searchParams.get("amountSol");
    const amount = amountSol != null ? Number(amountSol) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      sendError(res, 400, "INVALID_AMOUNT", "amountSol required and must be positive", "use_query_amountSol");
      return;
    }
    const solKey = getSolanaKeypair();
    const btcKey = getBtcKey();
    const btcAddress = getBtcAddress(btcKey);
    const fromAddress = solKey ? solKey.publicKey.toBase58() : "11111111111111111111111111111111";
    const quote = await lifiQuote(fromAddress, btcAddress || "16yEBGKD1jBFE2eRUchDJcpLLP3wLoD1Mz", Math.floor(amount * 1e9));
    const estimate = quote && quote.estimate ? quote.estimate : null;
    const estimatedSats = estimate && estimate.toAmount != null ? Math.round(Number(estimate.toAmount)) : null;
    res.writeHead(200);
    res.end(JSON.stringify({ amountSol: amount, estimatedBtcSats: estimatedSats }));
    return;
  }

  // Swap SOL → BTC: min amount and current balance (LI.FI: fixed min)
  if (path === "/api/swap/min" && req.method === "GET") {
    const solKey = getSolanaKeypair();
    let balanceSol = null;
    if (solKey) {
      const conn = new Connection(SOLANA_RPC);
      balanceSol = await fetchSolBalance(conn, solKey.publicKey);
    }
    res.writeHead(200);
    res.end(
      JSON.stringify({
        minAmountSol: LIFI_MIN_SOL,
        balanceSol: balanceSol != null ? balanceSol : null,
      })
    );
    return;
  }

  // Swap SOL → BTC: get LI.FI quote, sign and send Solana tx, store in DB (id = signature)
  if (path === "/api/swap/create" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      sendError(res, 400, "INVALID_JSON", "Invalid JSON body", "send_valid_json");
      return;
    }
    const amountSol = body.amountSol != null ? Number(body.amountSol) : NaN;
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      sendError(res, 400, "INVALID_AMOUNT", "amountSol required and must be positive", "use_positive_amountSol");
      return;
    }
    const btcKey = getBtcKey();
    const solKey = getSolanaKeypair();
    const btcAddress = getBtcAddress(btcKey);
    if (!btcAddress || !solKey) {
      sendError(res, 503, "SERVICE_CONFIG", "BTC or Solana key not configured", null);
      return;
    }
    if (amountSol < LIFI_MIN_SOL) {
      sendError(res, 400, "MIN_SOL_EXCEEDED", `Minimum SOL amount is ${LIFI_MIN_SOL}`, "use_amountSol_at_least_" + LIFI_MIN_SOL);
      return;
    }
    const conn = new Connection(SOLANA_RPC);
    const balanceSol = await fetchSolBalance(conn, solKey.publicKey);
    const fromAmountLamports = Math.floor(amountSol * 1e9);
    const requiredLamports = fromAmountLamports + SOL_FEE_RESERVE_LAMPORTS;
    const balanceLamports = balanceSol != null ? Math.floor(balanceSol * 1e9) : 0;
    if (balanceLamports < requiredLamports) {
      sendError(res, 400, "INSUFFICIENT_BALANCE", "Insufficient SOL balance (including fee reserve)", "top_up_wallet");
      return;
    }
    const fromAddress = solKey.publicKey.toBase58();
    const quote = await lifiQuote(fromAddress, btcAddress, fromAmountLamports);
    if (!quote || !quote.transactionRequest || !quote.transactionRequest.data) {
      sendError(res, 502, "UPSTREAM_ERROR", "LI.FI: no quote or transaction data (try again or check amount)", "retry_or_reduce_amount");
      return;
    }
    const estimate = quote.estimate || {};
    const expectedBtcSats = estimate.toAmount != null ? Math.round(Number(estimate.toAmount)) : null;
    const txBuffer = Buffer.from(quote.transactionRequest.data, "base64");
    if (txBuffer.length === 0) {
      sendError(res, 502, "UPSTREAM_ERROR", "LI.FI: empty transaction data", "retry_later");
      return;
    }
    const u8 = new Uint8Array(txBuffer);
    let signedTxBuffer;
    try {
      const versionedTx = VersionedTransaction.deserialize(u8);
      versionedTx.sign([solKey]);
      signedTxBuffer = Buffer.from(versionedTx.serialize());
    } catch (_) {
      try {
        const legacyTx = Transaction.from(txBuffer);
        legacyTx.sign(solKey);
        signedTxBuffer = Buffer.from(legacyTx.serialize());
      } catch (e) {
        sendError(res, 502, "UPSTREAM_ERROR", "LI.FI: failed to sign transaction – " + (e.message || String(e)), "retry_later");
        return;
      }
    }
    let solanaSignature;
    try {
      solanaSignature = await conn.sendRawTransaction(signedTxBuffer, { skipPreflight: true });
    } catch (e) {
      sendError(res, 502, "UPSTREAM_ERROR", "Solana send failed: " + (e.message || String(e)), "retry_later");
      return;
    }
    if (pgPool) {
      try {
        await pgPool.query(
          "INSERT INTO swap_transactions (changenow_id, sol_amount, btc_sats, status, solana_signature) VALUES ($1, $2, $3, $4, $5)",
          [solanaSignature, amountSol, expectedBtcSats, "waiting", solanaSignature]
        );
      } catch (_) {}
    }
    const tool = quote.tool || "near";
    res.writeHead(200);
    res.end(
      JSON.stringify({
        initiated: true,
        id: solanaSignature,
        amountSol,
        expectedBtcSats,
        solanaSignature,
        status: "waiting",
        statusUrl: "https://explorer.li.fi",
        message: "Swap initiated. You have the tx id; no need to wait for BTC confirmation (can take minutes to hours). Poll GET /api/swap/status/" + solanaSignature + " only if you need completion status.",
      })
    );
    return;
  }

  // Swap status: poll LI.FI by tx hash (id = Solana signature)
  const swapStatusMatch = path.match(/^\/api\/swap\/status\/([^/]+)$/);
  if (swapStatusMatch && req.method === "GET") {
    const id = swapStatusMatch[1];
    const statusData = await lifiStatus(id, "near");
    if (!statusData) {
      sendError(res, 404, "NOT_FOUND", "Transaction not found", "check_swap_id");
      return;
    }
    const lifiStatusStr = statusData.status || "";
    const status = lifiStatusStr === "DONE" ? "finished" : lifiStatusStr === "FAILED" ? "failed" : "waiting";
    const btcSats = statusData.receivingTx && statusData.receivingTx.toAmount != null ? Math.round(Number(statusData.receivingTx.toAmount)) : (statusData.toAmount != null ? Math.round(Number(statusData.toAmount)) : null);
    if (pgPool && (status === "finished" || status === "failed")) {
      try {
        await pgPool.query(
          "UPDATE swap_transactions SET status = $1, btc_sats = COALESCE($2, btc_sats), updated_at = NOW() WHERE changenow_id = $3 OR solana_signature = $3",
          [status, btcSats, id]
        );
        if (status === "finished" && btcSats != null) {
          let btcPriceUsd = null;
          try {
            const r = await fetch("https://api.hyperliquid.xyz/info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "allMids" }),
            });
            if (r.ok) {
              const mids = await r.json();
              if (mids && typeof mids === "object" && mids.BTC != null) {
                btcPriceUsd = Number(mids.BTC);
              }
            }
          } catch (_) {}
          const amountUsd = btcPriceUsd != null ? (btcSats / 1e8) * btcPriceUsd : null;
          try {
            await pgPool.query(
              "INSERT INTO arbitrage_transactions (external_id, type, amount_sats, amount_usd, status, signature) VALUES ($1, $2, $3, $4, $5, $6)",
              [id, "issue", btcSats, amountUsd, "confirmed", id]
            );
          } catch (_) {}
        }
      } catch (_) {}
    }
    res.writeHead(200);
    res.end(
      JSON.stringify({
        id,
        status,
        amountSol: statusData.sendingTx && statusData.sendingTx.fromAmount != null ? Number(statusData.sendingTx.fromAmount) / 1e9 : null,
        btcSats,
      })
    );
    return;
  }

  // --- Explorer: invoices (agent: submit details → pay invoice → we create token + list) ---
  if (path === "/api/invoices" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); } catch (_) {
      sendError(res, 400, "INVALID_JSON", "Invalid JSON body", "send_valid_json");
      return;
    }
    const name = body.name != null ? String(body.name).trim() : "";
    const symbol = body.symbol != null ? String(body.symbol).trim() : "";
    if (!name || !symbol) {
      sendError(res, 400, "MISSING_FIELD", "name and symbol are required", "include_name_and_symbol");
      return;
    }
    const decimals = Math.min(9, Math.max(0, Number(body.decimals) || 9));
    const supply = body.supply != null ? String(body.supply).replace(/,/g, "") : "0";
    const supplyNum = BigInt(supply) >= 0n ? supply : "0";
    const description = body.description != null ? String(body.description).trim() : null;
    const revokeFreeze = !!body.revoke_freeze_authority;
    const revokeMint = !!body.revoke_mint_authority;
    const revokeUpdate = !!body.revoke_update_authority;
    const metaplex = !!body.metaplex_metadata;
    const creatorAddress = body.creator_address != null ? String(body.creator_address).trim() || null : null;
    if (!creatorAddress) {
      sendError(res, 400, "CREATOR_ADDRESS_REQUIRED", "creator_address is required (we create an SPL mint and send the supply to this wallet)", "include_creator_address");
      return;
    }
    if (!pgPool) {
      sendError(res, 503, "DATABASE_NOT_CONFIGURED", "Database not configured", null);
      return;
    }
    if (!TREASURY_SOLANA_ADDRESS) {
      sendError(res, 503, "TREASURY_NOT_CONFIGURED", "Treasury not configured", null);
      return;
    }
    const feeSol = invoiceFeeSol();
    const feeLamports = Math.ceil(feeSol * 1e9);
    try {
      const q = await pgPool.query(
        `INSERT INTO invoices (name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, creator_address, fee_sol, fee_lamports, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
         RETURNING id, fee_sol, fee_lamports, created_at`,
        [name, symbol, decimals, supplyNum, description, revokeFreeze, revokeMint, revokeUpdate, metaplex, creatorAddress, feeSol, feeLamports]
      );
      const row = q.rows[0];
      const feeSol = Number(row.fee_sol);
      res.writeHead(200);
      res.end(JSON.stringify({
        status: "pending_payment",
        invoice_id: row.id,
        treasury_address: TREASURY_SOLANA_ADDRESS,
        address: TREASURY_SOLANA_ADDRESS,
        amount: feeSol,
        fee_sol: feeSol,
        fee_lamports: Number(row.fee_lamports),
        currency: "SOL",
        message: "Pay this amount to our treasury. Once confirmed, we create the token and add it to the listing.",
        created_at: row.created_at,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message || "Failed to create invoice" }));
    }
    return;
  }

  const invoiceIdMatch = path.match(/^\/api\/invoices\/([0-9a-f-]+)$/);
  if (invoiceIdMatch && req.method === "GET") {
    const invoiceId = invoiceIdMatch[1];
    if (!pgPool) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const q = await pgPool.query(
        `SELECT id, name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, creator_address, fee_sol, fee_lamports, status, payment_tx_signature, token_id, created_at, paid_at, completed_at FROM invoices WHERE id = $1`,
        [invoiceId]
      );
      if (q.rows.length === 0) {
        sendError(res, 404, "NOT_FOUND", "Invoice not found", "check_invoice_id");
        return;
      }
      const r = q.rows[0];
      res.writeHead(200);
      res.end(JSON.stringify({
        invoice_id: r.id,
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
        supply: String(r.supply),
        description: r.description,
        revoke_freeze_authority: r.revoke_freeze_authority,
        revoke_mint_authority: r.revoke_mint_authority,
        revoke_update_authority: r.revoke_update_authority,
        metaplex_metadata: r.metaplex_metadata,
        creator_address: r.creator_address,
        fee_sol: Number(r.fee_sol),
        fee_lamports: Number(r.fee_lamports),
        status: r.status,
        payment_tx_signature: r.payment_tx_signature,
        token_id: r.token_id,
        created_at: r.created_at,
        paid_at: r.paid_at,
        completed_at: r.completed_at,
      }));
    } catch (_) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  if (path === "/api/invoices/confirm" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); } catch (_) {
      sendError(res, 400, "INVALID_JSON", "Invalid JSON body", "send_valid_json");
      return;
    }
    const invoiceId = (body.invoice_id || body.invoiceId || "").trim();
    const txSignature = (body.tx_signature || body.txSignature || "").trim();
    if (!invoiceId || !txSignature) {
      sendError(res, 400, "MISSING_FIELD", "invoice_id and tx_signature are required", "include_invoice_id_and_tx_signature");
      return;
    }
    if (!pgPool || !TREASURY_SOLANA_ADDRESS) {
      sendError(res, 503, "SERVICE_CONFIG", "Database or treasury not configured", null);
      return;
    }
    try {
      const sel = await pgPool.query(
        "SELECT id, name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, creator_address, fee_sol, fee_lamports, status, token_id FROM invoices WHERE id = $1",
        [invoiceId]
      );
      if (sel.rows.length === 0) {
        sendError(res, 404, "NOT_FOUND", "Invoice not found", "check_invoice_id");
        return;
      }
      const inv = sel.rows[0];
      if (inv.status === "completed") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, status: "completed", token_id: inv.token_id, message: "Already completed" }));
        return;
      }
      if (inv.status !== "pending") {
        sendError(res, 400, "INVOICE_NOT_PENDING", "Invoice is not pending", "use_pending_invoice");
        return;
      }
      const feeLamports = Number(inv.fee_lamports);
      const valid = await verifySolPaymentToTreasury(txSignature, feeLamports);
      if (!valid) {
        sendError(res, 400, "INVALID_PAYMENT", "Invalid payment: transaction must send at least " + inv.fee_sol + " SOL to the treasury", "send_exact_fee_to_treasury");
        return;
      }
      const solanaKeypair = getSolanaKeypair();
      if (!solanaKeypair) {
        sendError(res, 503, "SERVICE_CONFIG", "SPL token creation not configured (SOLANA_PRIVATE_KEY required)", null);
        return;
      }
      const { mintAddress } = await createSplTokenForInvoice(inv, solanaKeypair);
      const tokenIns = await pgPool.query(
        `INSERT INTO tokens (name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [inv.name, inv.symbol, inv.decimals, inv.supply, inv.description, inv.revoke_freeze_authority, inv.revoke_mint_authority, inv.revoke_update_authority, inv.metaplex_metadata, mintAddress, inv.creator_address]
      );
      const tokenId = tokenIns.rows[0].id;
      await pgPool.query(
        `INSERT INTO listing_requests (token_id, fee_sol, status, payment_tx_signature, confirmed_at) VALUES ($1, $2, 'confirmed', $3, NOW())
         ON CONFLICT (token_id) DO UPDATE SET status = 'confirmed', payment_tx_signature = $3, confirmed_at = NOW()`,
        [tokenId, inv.fee_sol, txSignature]
      );
      await pgPool.query(
        "UPDATE invoices SET status = 'completed', payment_tx_signature = $1, token_id = $2, paid_at = NOW(), completed_at = NOW() WHERE id = $3",
        [txSignature, tokenId, invoiceId]
      );
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, status: "completed", token_id: tokenId, mint_address: mintAddress, message: "Token created and listed" }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message || "Failed to confirm invoice" }));
    }
    return;
  }

  // --- Explorer: tokens and listings ---
  if (path === "/api/tokens" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); } catch (_) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const name = body.name != null ? String(body.name).trim() : "";
    const symbol = body.symbol != null ? String(body.symbol).trim() : "";
    if (!name || !symbol) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "name and symbol are required" }));
      return;
    }
    const decimals = Math.min(9, Math.max(0, Number(body.decimals) || 9));
    const supply = body.supply != null ? String(body.supply).replace(/,/g, "") : "0";
    const supplyNum = BigInt(supply) >= 0n ? supply : "0";
    const description = body.description != null ? String(body.description).trim() : null;
    const revokeFreeze = !!body.revoke_freeze_authority;
    const revokeMint = !!body.revoke_mint_authority;
    const revokeUpdate = !!body.revoke_update_authority;
    const metaplex = !!body.metaplex_metadata;
    const creatorAddress = body.creator_address != null ? String(body.creator_address).trim() || null : null;
    const mintAddress = body.mint_address != null ? String(body.mint_address).trim() || null : null;
    if (!pgPool) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Database not configured" }));
      return;
    }
    try {
      const q = await pgPool.query(
        `INSERT INTO tokens (name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address, created_at`,
        [name, symbol, decimals, supplyNum, description, revokeFreeze, revokeMint, revokeUpdate, metaplex, mintAddress, creatorAddress]
      );
      const row = q.rows[0];
      res.writeHead(200);
      res.end(JSON.stringify({
        id: row.id,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        supply: String(row.supply),
        description: row.description,
        revoke_freeze_authority: row.revoke_freeze_authority,
        revoke_mint_authority: row.revoke_mint_authority,
        revoke_update_authority: row.revoke_update_authority,
        metaplex_metadata: row.metaplex_metadata,
        mint_address: row.mint_address,
        creator_address: row.creator_address,
        created_at: row.created_at,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message || "Failed to create token" }));
    }
    return;
  }

  if (path === "/api/tokens" && req.method === "GET") {
    const creator = url.searchParams.get("creator");
    if (!pgPool) {
      res.writeHead(200);
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    try {
      let q;
      if (creator) {
        q = await pgPool.query(
          `SELECT id, name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address, created_at FROM tokens WHERE creator_address = $1 ORDER BY created_at DESC`,
          [creator]
        );
      } else {
        q = await pgPool.query(
          `SELECT id, name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address, created_at FROM tokens ORDER BY created_at DESC LIMIT 200`
        );
      }
      const tokens = q.rows.map((r) => ({
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
        supply: String(r.supply),
        description: r.description,
        revoke_freeze_authority: r.revoke_freeze_authority,
        revoke_mint_authority: r.revoke_mint_authority,
        revoke_update_authority: r.revoke_update_authority,
        metaplex_metadata: r.metaplex_metadata,
        mint_address: r.mint_address,
        creator_address: r.creator_address,
        created_at: r.created_at,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ tokens }));
    } catch (_) {
      res.writeHead(200);
      res.end(JSON.stringify({ tokens: [] }));
    }
    return;
  }

  const tokenIdMatch = path.match(/^\/api\/tokens\/(\d+)$/);
  if (tokenIdMatch && req.method === "GET") {
    const id = parseInt(tokenIdMatch[1], 10);
    if (!pgPool || !Number.isInteger(id)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const q = await pgPool.query(
        `SELECT id, name, symbol, decimals, supply, description, revoke_freeze_authority, revoke_mint_authority, revoke_update_authority, metaplex_metadata, mint_address, creator_address, created_at FROM tokens WHERE id = $1`,
        [id]
      );
      if (q.rows.length === 0) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Token not found" }));
        return;
      }
      const r = q.rows[0];
      res.writeHead(200);
      res.end(JSON.stringify({
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
        supply: String(r.supply),
        description: r.description,
        revoke_freeze_authority: r.revoke_freeze_authority,
        revoke_mint_authority: r.revoke_mint_authority,
        revoke_update_authority: r.revoke_update_authority,
        metaplex_metadata: r.metaplex_metadata,
        mint_address: r.mint_address,
        creator_address: r.creator_address,
        created_at: r.created_at,
      }));
    } catch (_) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  if (path === "/api/listings/request" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); } catch (_) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const tokenId = body.token_id != null ? parseInt(String(body.token_id), 10) : NaN;
    if (!pgPool || !Number.isInteger(tokenId) || tokenId < 1) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Valid token_id is required" }));
      return;
    }
    if (!TREASURY_SOLANA_ADDRESS) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Treasury not configured" }));
      return;
    }
    const feeSol = LISTING_FEE_SOL;
    const feeLamports = Math.ceil(feeSol * 1e9);
    try {
      const exists = await pgPool.query("SELECT id FROM tokens WHERE id = $1", [tokenId]);
      if (exists.rows.length === 0) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Token not found" }));
        return;
      }
      const ins = await pgPool.query(
        `INSERT INTO listing_requests (token_id, fee_sol, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (token_id) DO UPDATE SET fee_sol = $2, status = 'pending', payment_tx_signature = NULL, confirmed_at = NULL RETURNING id`,
        [tokenId, feeSol]
      );
      const row = ins.rows[0];
      res.writeHead(200);
      res.end(JSON.stringify({
        listing_request_id: row.id,
        treasury_address: TREASURY_SOLANA_ADDRESS,
        fee_sol: feeSol,
        fee_lamports: feeLamports,
        message: `Send exactly ${feeSol} SOL to the treasury address. After sending, submit the transaction signature to confirm your listing.`,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message || "Failed to create listing request" }));
    }
    return;
  }

  if (path === "/api/listings/confirm" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); } catch (_) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const listingRequestId = body.listing_request_id || body.listingRequestId;
    const txSignature = (body.tx_signature || body.txSignature || "").trim();
    if (!listingRequestId || !txSignature) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "listing_request_id and tx_signature are required" }));
      return;
    }
    if (!pgPool || !TREASURY_SOLANA_ADDRESS) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Listings or treasury not configured" }));
      return;
    }
    const feeLamports = Math.ceil(LISTING_FEE_SOL * 1e9);
    try {
      const sel = await pgPool.query("SELECT id, token_id, status FROM listing_requests WHERE id = $1", [listingRequestId]);
      if (sel.rows.length === 0) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Listing request not found" }));
        return;
      }
      const row = sel.rows[0];
      if (row.status === "confirmed") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, status: "confirmed", message: "Already confirmed" }));
        return;
      }
      const valid = await verifySolPaymentToTreasury(txSignature, feeLamports);
      if (!valid) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid payment: transaction must send at least " + LISTING_FEE_SOL + " SOL to the treasury address" }));
        return;
      }
      await pgPool.query(
        "UPDATE listing_requests SET status = 'confirmed', payment_tx_signature = $1, confirmed_at = NOW() WHERE id = $2",
        [txSignature, listingRequestId]
      );
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, status: "confirmed", message: "Listing confirmed" }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message || "Failed to confirm listing" }));
    }
    return;
  }

  if (path === "/api/listings/ensure-absr" && req.method === "GET") {
    if (!pgPool) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: "Database not configured" }));
      return;
    }
    let errMsg = null;
    const origDone = absrListedEnsureDone;
    absrListedEnsureDone = false;
    try {
      await ensureAbsrListed({ rethrow: true });
      if (!absrListedEnsureDone) errMsg = "ensureAbsrListed did not complete (check server logs)";
    } catch (e) {
      errMsg = (e.message || String(e)) + (e.code ? ` (${e.code})` : "") + (e.detail ? ` ${e.detail}` : "");
    }
    absrListedEnsureDone = origDone;
    if (errMsg) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: errMsg }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    }
    return;
  }

  if (path === "/api/listings/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!pgPool) {
      res.writeHead(200);
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    try {
      await ensureAbsrListed();
      let sql = `SELECT t.id, t.name, t.symbol, t.decimals, t.supply, t.description, t.revoke_freeze_authority, t.revoke_mint_authority, t.revoke_update_authority, t.metaplex_metadata, t.mint_address, t.creator_address, t.created_at, l.confirmed_at AS listed_at
                 FROM tokens t INNER JOIN listing_requests l ON l.token_id = t.id AND l.status = 'confirmed'`;
      const params = [];
      if (q.length > 0) {
        params.push("%" + q.replace(/%/g, "\\%") + "%");
        sql += " WHERE (t.name ILIKE $1 OR t.symbol ILIKE $1)";
      }
      sql += " ORDER BY l.confirmed_at DESC NULLS LAST, t.created_at DESC LIMIT 100";
      const result = await pgPool.query(sql, params);
      const tokens = result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
        supply: String(r.supply),
        description: r.description,
        revoke_freeze_authority: r.revoke_freeze_authority,
        revoke_mint_authority: r.revoke_mint_authority,
        revoke_update_authority: r.revoke_update_authority,
        metaplex_metadata: r.metaplex_metadata,
        mint_address: r.mint_address,
        creator_address: r.creator_address,
        created_at: r.created_at,
        listed_at: r.listed_at,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ tokens }));
    } catch (_) {
      res.writeHead(200);
      res.end(JSON.stringify({ tokens: [] }));
    }
    return;
  }

  if (path === "/api/listings" && req.method === "GET") {
    const tokenId = url.searchParams.get("token_id");
    if (!pgPool) {
      res.writeHead(200);
      res.end(JSON.stringify({ listings: [] }));
      return;
    }
    try {
      let sql = "SELECT l.id, l.token_id, l.fee_sol, l.status, l.payment_tx_signature, l.created_at, l.confirmed_at FROM listing_requests l";
      const params = [];
      if (tokenId) {
        const tid = parseInt(tokenId, 10);
        if (Number.isInteger(tid)) {
          params.push(tid);
          sql += " WHERE l.token_id = $1";
        }
      }
      sql += " ORDER BY l.created_at DESC LIMIT 100";
      const result = await pgPool.query(sql, params);
      const listings = result.rows.map((r) => ({
        listing_request_id: r.id,
        token_id: r.token_id,
        fee_sol: Number(r.fee_sol),
        status: r.status,
        payment_tx_signature: r.payment_tx_signature,
        created_at: r.created_at,
        confirmed_at: r.confirmed_at,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ listings }));
    } catch (_) {
      res.writeHead(200);
      res.end(JSON.stringify({ listings: [] }));
    }
    return;
  }

  if (path === "/api/explorer/treasury" && req.method === "GET") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        treasury_address: TREASURY_SOLANA_ADDRESS || null,
        listing_fee_sol: LISTING_FEE_SOL,
        invoice_fee_sol: invoiceFeeSol(),
        estimated_creation_sol: ESTIMATED_CREATION_SOL,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Proof-of-reserves API listening on http://127.0.0.1:${PORT}`);
  ensureAbsrListed();
});
