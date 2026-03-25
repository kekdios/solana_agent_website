/**
 * Proof-of-reserves API for Solana Agent website.
 * Env: BTC_PRIVATE_KEY_WIF, SOLANA_PRIVATE_KEY. SOL→BTC swap via LI.FI (no API key required).
 */
const http = require("http");
const fs = require("fs");
const nodePath = require("path");
const { Keypair, Connection, PublicKey, Transaction, VersionedTransaction, SystemProgram } = require("@solana/web3.js");
const { createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, AuthorityType, getMint, getAssociatedTokenAddress } = require("@solana/spl-token");
const bs58 = require("bs58");
const bitcoin = require("bitcoinjs-lib");
const bitcoinMessage = require("bitcoinjs-message");
const nacl = require("tweetnacl");
const { receiveStableConfirmAndReward } = require("./lib/asry/receive-confirm-and-reward.cjs");
const { fetchWhirlpoolPoolFromRpc } = require("./lib/orca-whirlpool-onchain.cjs");
const { tryHandleNostr } = require("./lib/nostr-api-routes.cjs");

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
const ASRY_MINT_ADDRESS = (process.env.ASRY_MINT_ADDRESS || "").trim() || "3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw";
/** Treasury reserve SPL mints (mainnet); override with SAUSD_MINT_ADDRESS / SABTC_MINT_ADDRESS / SAETH_MINT_ADDRESS. */
const SAUSD_MINT_ADDRESS = (process.env.SAUSD_MINT_ADDRESS || "").trim() || "CK9PodBifHymLBGeZujExFnpoLCsYxAw7t8c8LsDKLxG";
const SABTC_MINT_ADDRESS = (process.env.SABTC_MINT_ADDRESS || "").trim() || "2kR1UKhrXq6Hef6EukLyzdD5ahcezRqwURKdtCJx2Ucy";
const SAETH_MINT_ADDRESS = (process.env.SAETH_MINT_ADDRESS || "").trim() || "AhyZRrDrN3apDzZqdRHtpxWmnqYDdL8VnJ66ip1KbiDS";
/** Default SABTC/SAUSD Whirlpool for site links; override with SABTC_ORCA_POOL_ADDRESS. */
const SABTC_ORCA_POOL_ADDRESS =
  (process.env.SABTC_ORCA_POOL_ADDRESS || "").trim() || "GSpVz4P5HKzVBccAFAdfWzXc1VYhGLKvzRNQZCw4KCoJ";
/** Default SAETH/SAUSD Whirlpool (matches saeth.html); override with SAETH_SAUSD_ORCA_POOL_ADDRESS. */
const SAETH_SAUSD_ORCA_POOL_ADDRESS =
  (process.env.SAETH_SAUSD_ORCA_POOL_ADDRESS || "").trim() || "BzwjX8hwMbkVdhGu2w9qTtokr5ExqSDSw9bNMxdkExRS";
/** Default SAUSD / native USDC Whirlpool (matches treasury.html); override with SAUSD_USDC_ORCA_POOL_ADDRESS. */
const SAUSD_USDC_ORCA_POOL_ADDRESS =
  (process.env.SAUSD_USDC_ORCA_POOL_ADDRESS || "").trim() || "B7rRNh2ur5K7xvFp8V3L5wJ6qKxnfNeKSq76Bz3EfLdK";
const ORCA_POOLS_API = "https://api.orca.so/v2/solana/pools";
const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function isLikelySolanaPubkey(s) {
  const t = String(s || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(t);
}

function orcaTokenBalanceIsZeroish(v) {
  if (v == null || v === "") return true;
  if (typeof v === "number" && v === 0) return true;
  const n = String(v).trim();
  if (n === "0") return true;
  try {
    return BigInt(n) === 0n;
  } catch (_) {
    return false;
  }
}

/**
 * Orca REST often returns tokenBalanceA/B as "0" for splash / flagged pools while SPL vaults hold liquidity.
 * Fill from Solana RPC so site matches explorer vault accounts (e.g. SAUSD/USDC Whirlpool).
 */
async function enrichOrcaPoolVaultBalancesFromRpc(data) {
  if (!data || typeof data !== "object") return;
  if (!orcaTokenBalanceIsZeroish(data.tokenBalanceA) || !orcaTokenBalanceIsZeroish(data.tokenBalanceB)) return;
  const va = data.tokenVaultA;
  const vb = data.tokenVaultB;
  if (!isLikelySolanaPubkey(va) || !isLikelySolanaPubkey(vb)) return;
  try {
    const conn = new Connection(SOLANA_RPC);
    const [ra, rb] = await Promise.all([
      conn.getTokenAccountBalance(new PublicKey(va)),
      conn.getTokenAccountBalance(new PublicKey(vb)),
    ]);
    if (ra?.value?.amount != null) data.tokenBalanceA = ra.value.amount;
    if (rb?.value?.amount != null) data.tokenBalanceB = rb.value.amount;
    if (data.tokenA && typeof ra?.value?.decimals === "number") data.tokenA.decimals = ra.value.decimals;
    if (data.tokenB && typeof rb?.value?.decimals === "number") data.tokenB.decimals = rb.value.decimals;
    data.vault_balances_source = "solana_rpc";
  } catch (_) {}
}

const TREASURY_TOKEN_MINT_BY_ID = {
  sausd: SAUSD_MINT_ADDRESS,
  sabtc: SABTC_MINT_ADDRESS,
  saeth: SAETH_MINT_ADDRESS,
};

function decodeMplTokenMetadataNameSymbol(data) {
  if (!data || !Buffer.isBuffer(data) || data.length < 100) return { name: null, symbol: null };
  try {
    let i = 1 + 32 + 32;
    const readStr = () => {
      const len = data.readUInt32LE(i);
      i += 4;
      const s = data.slice(i, i + len).toString("utf8").replace(/\0/g, "").trim();
      i += len;
      return s;
    };
    const name = readStr();
    const symbol = readStr();
    return { name, symbol };
  } catch (_) {
    return { name: null, symbol: null };
  }
}

async function fetchMplTokenMetadataNameSymbol(connection, mintAddress) {
  const mint = new PublicKey(mintAddress);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA
  );
  const acc = await connection.getAccountInfo(pda);
  if (!acc || !acc.data) return { name: null, symbol: null };
  return decodeMplTokenMetadataNameSymbol(Buffer.from(acc.data));
}
const PROOF_MESSAGE_PREFIX = "Solana Agent proof of reserves";
const LIFI_BASE = "https://li.quest/v1";
const LIFI_FROM_CHAIN = "1151111081099710";
const LIFI_TO_CHAIN = "20000000000001";
const SOL_FEE_RESERVE_LAMPORTS = 10000;
/** Minimum SOL amount for LI.FI SOL→BTC (conservative; quote may allow slightly less). */
const LIFI_MIN_SOL = 0.001;
const CLAIMED_DEPOSIT_SIGS = new Set();


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

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

async function fetchSolanaTokenBalances(connection, walletPublicKey) {
  if (!connection || !walletPublicKey) return { sol: null, usdc: null, usdt: null };
  const pubkey = walletPublicKey instanceof PublicKey ? walletPublicKey : new PublicKey(walletPublicKey);
  try {
    const solLamports = await connection.getBalance(pubkey);
    const sol = solLamports / 1e9;
    let usdc = null, usdt = null;
    try {
      const usdcAta = await getAssociatedTokenAddress(USDC_MINT, pubkey, true);
      const usdcAcc = await connection.getTokenAccountBalance(usdcAta);
      const raw = Number(usdcAcc.value.amount);
      usdc = raw === 0 ? 0 : (usdcAcc.value.uiAmount != null ? usdcAcc.value.uiAmount : raw / Math.pow(10, usdcAcc.value.decimals || 6));
    } catch (_) {}
    try {
      const usdtAta = await getAssociatedTokenAddress(USDT_MINT, pubkey, true);
      const usdtAcc = await connection.getTokenAccountBalance(usdtAta);
      const raw = Number(usdtAcc.value.amount);
      usdt = raw === 0 ? 0 : (usdtAcc.value.uiAmount != null ? usdtAcc.value.uiAmount : raw / Math.pow(10, usdtAcc.value.decimals || 6));
    } catch (_) {}
    return { sol, usdc, usdt };
  } catch (_) {
    return { sol: null, usdc: null, usdt: null };
  }
}

async function fetchSolanaAddressBalances(connection, address) {
  if (!connection || !address) return { sol: null, usdc: null, usdt: null };
  const pubkey = address instanceof PublicKey ? address : new PublicKey(address);
  try {
    const parsed = await connection.getParsedAccountInfo(pubkey);
    const data = parsed && parsed.value && parsed.value.data;
    const isTokenAccount = data && typeof data === "object" && data.program === "spl-token" && data.parsed && data.parsed.type === "account";
    if (isTokenAccount) {
      const mint = data.parsed?.info?.mint || null;
      const tokenAmount = data.parsed?.info?.tokenAmount || null;
      const raw = tokenAmount && tokenAmount.amount != null ? Number(tokenAmount.amount) : NaN;
      const decimals = tokenAmount && tokenAmount.decimals != null ? Number(tokenAmount.decimals) : 6;
      const uiAmount = tokenAmount && tokenAmount.uiAmount != null
        ? Number(tokenAmount.uiAmount)
        : (Number.isFinite(raw) ? raw / Math.pow(10, decimals || 6) : null);
      const amount = Number.isFinite(uiAmount) ? uiAmount : null;
      return {
        sol: null,
        usdc: mint === USDC_MINT.toBase58() ? (amount != null ? amount : null) : null,
        usdt: mint === USDT_MINT.toBase58() ? (amount != null ? amount : null) : null,
      };
    }
  } catch (_) {}
  return fetchSolanaTokenBalances(connection, pubkey);
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

function readJsonBodyMax(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return;
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (bytes > maxBytes) {
        reject(new Error("body_too_large"));
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const VISITOR_LOG_PATH = nodePath.resolve(
  process.env.VISITOR_LOG_PATH || nodePath.join(__dirname, "data", "site-visitors.jsonl")
);
const MAX_VISITOR_LOG_BYTES = Number(process.env.MAX_VISITOR_LOG_BYTES) || 8 * 1024 * 1024;
const ANALYTICS_PV_MAX_PER_HOUR = Number(process.env.ANALYTICS_PV_MAX_PER_HOUR) || 6000;

const _pvRate = new Map();

/** Best-effort client IP behind nginx / Cloudflare (never trust for security; OK for analytics + soft rate limit). */
function analyticsClientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf.slice(0, 128);
  const xf = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (xf) return xf.slice(0, 128);
  const xr = String(req.headers["x-real-ip"] || "").trim();
  if (xr) return xr.slice(0, 128);
  const a = req.socket && req.socket.remoteAddress;
  return a ? String(a).slice(0, 128) : "";
}

function analyticsIsLoopbackLike(ip) {
  const s = String(ip || "")
    .trim()
    .toLowerCase();
  return s === "127.0.0.1" || s === "::1" || s === "::ffff:127.0.0.1" || s === "localhost";
}

/**
 * When nginx proxies to Node, remoteAddress is often 127.0.0.1 for every visitor. Without X-Forwarded-For /
 * X-Real-IP, a single shared rate-limit bucket (600/h) dropped almost all pageviews. Skip limit for loopback-only peer.
 */
function analyticsRateOk(ip) {
  if (analyticsIsLoopbackLike(ip)) return true;
  const now = Date.now();
  const windowMs = 3600000;
  let b = _pvRate.get(ip);
  if (!b || now > b.reset) {
    b = { n: 0, reset: now + windowMs };
    _pvRate.set(ip, b);
  }
  if (b.n >= ANALYTICS_PV_MAX_PER_HOUR) return false;
  b.n += 1;
  return true;
}

function analyticsEnsureLogDir() {
  const dir = nodePath.dirname(VISITOR_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function analyticsRotateIfNeeded() {
  try {
    if (!fs.existsSync(VISITOR_LOG_PATH)) return;
    const st = fs.statSync(VISITOR_LOG_PATH);
    if (st.size <= MAX_VISITOR_LOG_BYTES) return;
    const arch = VISITOR_LOG_PATH.replace(/\.jsonl$/i, "") + "-" + Date.now() + ".jsonl";
    fs.renameSync(VISITOR_LOG_PATH, arch);
  } catch (e) {
    console.error("[analytics] rotate:", e && e.message ? e.message : e);
  }
}

function analyticsAppendRecord(obj) {
  analyticsEnsureLogDir();
  analyticsRotateIfNeeded();
  try {
    fs.appendFileSync(VISITOR_LOG_PATH, JSON.stringify(obj) + "\n", "utf8");
  } catch (e) {
    console.error("[analytics] append failed:", VISITOR_LOG_PATH, e && e.message ? e.message : e);
    throw e;
  }
}

function analyticsRedactIp(ip) {
  const s = String(ip || "").trim();
  if (!s) return "";
  if (s.includes(".")) {
    const p = s.split(".");
    if (p.length >= 4) return `${p[0]}.${p[1]}.${p[2]}.x`;
  }
  if (s.includes(":")) return s.split(":").slice(0, 3).join(":") + ":…";
  return s.slice(0, 12) + (s.length > 12 ? "…" : "");
}

function analyticsLoadRecords(maxTailBytes) {
  if (!fs.existsSync(VISITOR_LOG_PATH)) return [];
  const st = fs.statSync(VISITOR_LOG_PATH);
  let raw;
  if (st.size <= maxTailBytes) {
    raw = fs.readFileSync(VISITOR_LOG_PATH, "utf8");
  } else {
    const fd = fs.openSync(VISITOR_LOG_PATH, "r");
    const buf = Buffer.alloc(maxTailBytes);
    fs.readSync(fd, buf, 0, maxTailBytes, st.size - maxTailBytes);
    fs.closeSync(fd);
    raw = buf.toString("utf8");
    const nl = raw.indexOf("\n");
    if (nl !== -1) raw = raw.slice(nl + 1);
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {}
  }
  return out;
}

function analyticsStatsFromRecords(records) {
  const now = Date.now();
  const day = 86400000;
  const byPath = new Map();
  let last24 = 0;
  let last7 = 0;
  const ips24 = new Set();
  for (const r of records) {
    const p = typeof r.path === "string" ? r.path : "";
    byPath.set(p, (byPath.get(p) || 0) + 1);
    const t = r.t ? Date.parse(r.t) : NaN;
    if (Number.isFinite(t)) {
      if (now - t <= day) last24 += 1;
      if (now - t <= 7 * day) last7 += 1;
      if (now - t <= day && r.ip) ips24.add(String(r.ip));
    }
  }
  const by_path = [...byPath.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);
  const recent = records
    .slice(-80)
    .reverse()
    .map((r) => ({
      t: r.t || null,
      path: r.path || "",
      referrer: (r.referrer || "").slice(0, 160),
      ip: analyticsRedactIp(r.ip),
    }));
  return {
    total_pageviews: records.length,
    pageviews_last_24h: last24,
    pageviews_last_7d: last7,
    distinct_ips_last_24h: ips24.size,
    by_path: by_path.slice(0, 40),
    recent,
  };
}

function analyticsValidPath(p) {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (s.length === 0 || s.length > 512) return false;
  if (!s.startsWith("/")) return false;
  if (s.includes("..") || s.includes("\\") || s.includes("\0")) return false;
  return true;
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

  if (path === "/api/analytics/pageview" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (path === "/api/analytics/pageview" && req.method === "POST") {
    (async () => {
      const ip = analyticsClientIp(req);
      try {
        if (!analyticsRateOk(ip || "unknown")) {
          res.writeHead(429);
          res.end(JSON.stringify({ ok: false, error_code: "RATE_LIMITED", error: "Too many pageview events" }));
          return;
        }
        const body = await readJsonBodyMax(req, 8192);
        const p = body.path;
        const referrer = typeof body.referrer === "string" ? body.referrer.slice(0, 2048) : "";
        if (!analyticsValidPath(p)) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error_code: "BAD_PATH", error: "Invalid path" }));
          return;
        }
        try {
          analyticsAppendRecord({
            t: new Date().toISOString(),
            path: p,
            referrer,
            ip: ip || null,
          });
        } catch (appendErr) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              ok: false,
              error_code: "ANALYTICS_WRITE_FAILED",
              error: "Could not write visitor log (check server filesystem permissions for data/)",
            })
          );
          return;
        }
        res.writeHead(204);
        res.end();
      } catch (e) {
        const msg = e && e.message === "body_too_large" ? "Body too large" : "Bad JSON";
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error_code: "BAD_REQUEST", error: msg }));
      }
    })();
    return;
  }

  if (path === "/api/analytics/stats" && req.method === "GET") {
    try {
      const records = analyticsLoadRecords(6 * 1024 * 1024);
      const stats = analyticsStatsFromRecords(records);
      res.setHeader("Cache-Control", "private, no-store, max-age=0, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, log_path_hint: "data/site-visitors.jsonl", ...stats }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error_code: "STATS_ERROR", error: String(e && e.message ? e.message : e) }));
    }
    return;
  }

  try {
    if (await tryHandleNostr(req, res, path, url)) return;
  } catch (e) {
    console.error("[nostr-api]", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error_code: "NOSTR_API_ERROR", error: String(e && e.message ? e.message : e) }));
    }
    return;
  }
  if (path === "/api/reserves" && req.method === "GET") {
    const btcKey = getBtcKey();
    const solKey = getSolanaKeypair();
    const btcAddress = getBtcAddress(btcKey);
    const solAddress = (process.env.TREASURY_SOLANA_ADDRESS || "").trim() || (solKey ? solKey.publicKey.toBase58() : null);

    let btcBalance = null;
    let solBalances = { sol: null, usdc: null, usdt: null };
    if (btcAddress) btcBalance = await fetchBtcBalance(btcAddress);
    if (solAddress) {
      const { Connection } = require("@solana/web3.js");
      const conn = new Connection(SOLANA_RPC);
      solBalances = await fetchSolanaAddressBalances(conn, solAddress);
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        bitcoin: btcAddress
          ? { address: btcAddress, balanceBtc: btcBalance, balanceSat: btcBalance != null ? Math.round(btcBalance * 1e8) : null }
          : { address: null, balanceBtc: null, balanceSat: null },
        solana: solAddress
          ? { address: solAddress, balanceSol: solBalances.sol, balanceUsdc: solBalances.usdc, balanceUsdt: solBalances.usdt }
          : { address: null, balanceSol: null, balanceUsdc: null, balanceUsdt: null },
      })
    );
    return;
  }

  if (path.startsWith("/api/reserves/solana-address") && req.method === "GET") {
    const address = url.searchParams.get("address");
    if (!address || !address.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "address query parameter required" }));
      return;
    }
    try {
      const { Connection } = require("@solana/web3.js");
      const conn = new Connection(SOLANA_RPC);
      const balances = await fetchSolanaAddressBalances(conn, address.trim());
      res.writeHead(200);
      res.end(JSON.stringify({
        address: address.trim(),
        balanceSol: balances.sol,
        balanceUsdc: balances.usdc,
        balanceUsdt: balances.usdt,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (path.startsWith("/api/token-supply") && req.method === "GET") {
    const mintParam = url.searchParams.get("mint");
    if (!mintParam || !mintParam.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "mint query parameter required" }));
      return;
    }
    try {
      const { Connection } = require("@solana/web3.js");
      const conn = new Connection(SOLANA_RPC);
      const mintKey = new PublicKey(mintParam.trim());
      const mint = await getMint(conn, mintKey);
      const supplyRaw = Number(mint.supply);
      const decimals = mint.decimals;
      const supply = supplyRaw / Math.pow(10, decimals);
      res.writeHead(200);
      res.end(JSON.stringify({
        mint: mintParam.trim(),
        supply,
        supplyRaw: supplyRaw.toString(),
        decimals,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
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

  // (Token creation, invoices, and listings APIs removed.)

  // ASRY claim from confirmed stable deposit (sender inferred from chain data)
  if (path === "/api/asry/claim-from-deposit" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      sendError(res, 400, "INVALID_JSON", "Invalid JSON body", "send_valid_json");
      return;
    }
    const asset = String(body.asset || "").trim().toUpperCase();
    const depositTxSignature = String(body.depositTxSignature || "").trim();
    if (asset !== "USDC" && asset !== "USDT") {
      sendError(res, 400, "INVALID_ASSET", 'asset must be "USDC" or "USDT"', "set_asset_to_usdc_or_usdt");
      return;
    }
    if (!depositTxSignature) {
      sendError(res, 400, "MISSING_DEPOSIT_TX", "depositTxSignature is required", "provide_deposit_signature");
      return;
    }
    if (CLAIMED_DEPOSIT_SIGS.has(depositTxSignature)) {
      sendError(res, 409, "ALREADY_CLAIMED", "This deposit signature was already claimed", "use_new_deposit_signature");
      return;
    }
    const solKey = getSolanaKeypair();
    const treasuryAddress = (process.env.TREASURY_SOLANA_ADDRESS || "").trim() || (solKey ? solKey.publicKey.toBase58() : "");
    if (!solKey || !treasuryAddress) {
      sendError(res, 503, "SERVICE_CONFIG", "Solana signer/treasury not configured", null);
      return;
    }
    try {
      const out = await receiveStableConfirmAndReward({
        asset,
        depositTxSignature,
        treasuryAddress,
        signerKeypair: solKey,
        amount: body.amount,
        amountAtomic: body.amountAtomic,
        rewardUsd: body.rewardUsd,
        skipReward: !!body.skipReward,
      });
      if (out?.reward?.signature) CLAIMED_DEPOSIT_SIGS.add(depositTxSignature);
      res.writeHead(200);
      res.end(JSON.stringify(out));
    } catch (e) {
      if (e && e.partialResult) {
        res.writeHead(200);
        res.end(JSON.stringify(e.partialResult));
        return;
      }
      sendError(res, 500, e.code || "CLAIM_FAILED", e.message || "Claim failed", null);
    }
    return;
  }

  if (path === "/api/explorer/treasury" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ treasury_address: TREASURY_SOLANA_ADDRESS || null }));
    return;
  }

  if (path === "/api/asry-info" && req.method === "GET") {
    const mintAddress = ASRY_MINT_ADDRESS || null;
    if (!mintAddress) {
      res.writeHead(200);
      res.end(JSON.stringify({ mint_address: null, supply: null, decimals: null, creator_address: null }));
      return;
    }
    (async function () {
      try {
        const conn = new Connection(SOLANA_RPC);
        const mintInfo = await getMint(conn, new PublicKey(mintAddress));
        res.writeHead(200);
        res.end(
          JSON.stringify({
            mint_address: mintAddress,
            supply: mintInfo && mintInfo.supply != null ? String(mintInfo.supply) : null,
            decimals: mintInfo && mintInfo.decimals != null ? mintInfo.decimals : 9,
            creator_address: TREASURY_SOLANA_ADDRESS || null,
          })
        );
      } catch (e) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            mint_address: mintAddress,
            supply: null,
            decimals: 9,
            creator_address: TREASURY_SOLANA_ADDRESS || null,
            error: e.message || "Failed to fetch on-chain supply",
          })
        );
      }
    })();
    return;
  }

  if (path === "/api/asry/transactions" && req.method === "GET") {
    const mintAddress = ASRY_MINT_ADDRESS || null;
    if (!mintAddress) {
      res.writeHead(200);
      res.end(JSON.stringify({ transactions: [] }));
      return;
    }
    (async function () {
      try {
        const conn = new Connection(SOLANA_RPC);
        const sigs = await conn.getSignaturesForAddress(new PublicKey(mintAddress), { limit: 50 });
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
    })();
    return;
  }

  const orcaPoolMatch = path.match(/^\/api\/orca\/pool\/([^/]+)$/);
  if (orcaPoolMatch && req.method === "GET") {
    const poolAddr = String(orcaPoolMatch[1] || "").trim();
    if (!isLikelySolanaPubkey(poolAddr)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid pool address" }));
      return;
    }
    (async () => {
      const tryWhirlpoolRpc = async () => {
        try {
          const conn = new Connection(SOLANA_RPC);
          const out = await fetchWhirlpoolPoolFromRpc(conn, poolAddr);
          if (out.ok) return { status: 200, json: { data: out.data } };
        } catch (_) {}
        return null;
      };

      const sendNonJsonOrca = (r, text) => {
        const plain = text.trim().slice(0, 500);
        res.writeHead(r.ok ? 502 : r.status || 502);
        res.end(
          JSON.stringify({
            error: "orca_non_json",
            message: plain || "Orca API returned non-JSON",
            status: r.status,
            body_preview: text.slice(0, 500),
          })
        );
      };

      try {
        const orcaUrl = `${ORCA_POOLS_API}/${encodeURIComponent(poolAddr)}`;
        const r = await fetch(orcaUrl, { headers: { Accept: "application/json" } });
        const text = await r.text();
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          const rpc = await tryWhirlpoolRpc();
          if (rpc) {
            res.writeHead(200);
            res.end(JSON.stringify(rpc.json));
            return;
          }
          sendNonJsonOrca(r, text);
          return;
        }

        const hasOrcaPoolData =
          parsed &&
          parsed.data &&
          typeof parsed.data === "object" &&
          (parsed.data.address || parsed.data.tokenMintA);

        if (hasOrcaPoolData) {
          await enrichOrcaPoolVaultBalancesFromRpc(parsed.data);
          res.writeHead(r.status);
          res.end(JSON.stringify(parsed));
          return;
        }

        const rpc = await tryWhirlpoolRpc();
        if (rpc) {
          res.writeHead(200);
          res.end(JSON.stringify(rpc.json));
          return;
        }

        res.writeHead(r.status);
        res.end(JSON.stringify(parsed));
      } catch (e) {
        const rpc = await tryWhirlpoolRpc();
        if (rpc) {
          res.writeHead(200);
          res.end(JSON.stringify(rpc.json));
          return;
        }
        res.writeHead(502);
        res.end(JSON.stringify({ error: "orca_fetch_failed", message: e.message || String(e) }));
      }
    })();
    return;
  }

  if (path === "/api/orca/pool-default" && req.method === "GET") {
    res.writeHead(307, { Location: `/api/orca/pool/${encodeURIComponent(SABTC_ORCA_POOL_ADDRESS)}` });
    res.end();
    return;
  }

  if (path === "/api/orca/pool-saeth-sausd-default" && req.method === "GET") {
    res.writeHead(307, { Location: `/api/orca/pool/${encodeURIComponent(SAETH_SAUSD_ORCA_POOL_ADDRESS)}` });
    res.end();
    return;
  }

  if (path === "/api/orca/pool-sausd-usdc-default" && req.method === "GET") {
    res.writeHead(307, { Location: `/api/orca/pool/${encodeURIComponent(SAUSD_USDC_ORCA_POOL_ADDRESS)}` });
    res.end();
    return;
  }

  const treasuryTokenMatch = path.match(/^\/api\/treasury-token\/([^/]+)\/(info|transactions)$/);
  if (treasuryTokenMatch && req.method === "GET") {
    const tokenId = String(treasuryTokenMatch[1] || "").toLowerCase();
    const sub = treasuryTokenMatch[2];
    const mintAddress = TREASURY_TOKEN_MINT_BY_ID[tokenId];
    if (!mintAddress) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Unknown treasury token id", valid_ids: ["sausd", "sabtc", "saeth"] }));
      return;
    }
    if (sub === "info") {
      (async function () {
        try {
          const conn = new Connection(SOLANA_RPC);
          const mintPk = new PublicKey(mintAddress);
          const [mintInfo, meta] = await Promise.all([
            getMint(conn, mintPk),
            fetchMplTokenMetadataNameSymbol(conn, mintAddress).catch(() => ({ name: null, symbol: null })),
          ]);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              token_id: tokenId,
              mint_address: mintAddress,
              supply: mintInfo && mintInfo.supply != null ? String(mintInfo.supply) : null,
              decimals: mintInfo && mintInfo.decimals != null ? mintInfo.decimals : 9,
              creator_address: TREASURY_SOLANA_ADDRESS || null,
              token_name: meta && meta.name ? meta.name : null,
              token_symbol: meta && meta.symbol ? meta.symbol : null,
            })
          );
        } catch (e) {
          let meta = { name: null, symbol: null };
          try {
            const conn = new Connection(SOLANA_RPC);
            meta = await fetchMplTokenMetadataNameSymbol(conn, mintAddress);
          } catch (_) {}
          res.writeHead(200);
          res.end(
            JSON.stringify({
              token_id: tokenId,
              mint_address: mintAddress,
              supply: null,
              decimals: 9,
              creator_address: TREASURY_SOLANA_ADDRESS || null,
              token_name: meta.name || null,
              token_symbol: meta.symbol || null,
              error: e.message || "Failed to fetch on-chain mint",
            })
          );
        }
      })();
      return;
    }
    if (sub === "transactions") {
      (async function () {
        try {
          const conn = new Connection(SOLANA_RPC);
          const sigs = await conn.getSignaturesForAddress(new PublicKey(mintAddress), { limit: 50 });
          const transactions = sigs.map((s) => ({
            signature: s.signature,
            blockTime: s.blockTime,
            err: s.err ?? null,
          }));
          res.writeHead(200);
          res.end(JSON.stringify({ token_id: tokenId, transactions }));
        } catch (e) {
          res.writeHead(200);
          res.end(JSON.stringify({ token_id: tokenId, transactions: [] }));
        }
      })();
      return;
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Proof-of-reserves API listening on http://127.0.0.1:${PORT}`);
});
