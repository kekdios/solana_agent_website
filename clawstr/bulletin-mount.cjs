const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Connection } = require("@solana/web3.js");

const STORE_PATH = process.env.BULLETIN_STORE_PATH
  ? path.resolve(process.env.BULLETIN_STORE_PATH)
  : path.join(__dirname, "bulletin-store.local.json");
const PAYMENT_INTENT_TTL_MS = 15 * 60 * 1000;
const BULLETIN_TREASURY_SOL = (
  process.env.BULLETIN_TREASURY_SOLANA_ADDRESS ||
  process.env.TREASURY_SOLANA_ADDRESS ||
  ""
).trim();
const BULLETIN_FEE_LAMPORTS = Math.max(1, Number(process.env.BULLETIN_FEE_LAMPORTS || "10000000"));
const BULLETIN_ADMIN_TOKEN = (process.env.BULLETIN_ADMIN_TOKEN || "").trim();
const BULLETIN_SOLANA_RPC = (process.env.BULLETIN_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
const BULLETIN_ALLOW_FAKE_CONFIRM = /^(1|true|yes)$/i.test(String(process.env.BULLETIN_ALLOW_FAKE_CONFIRM || ""));

function json(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function ensureStore() {
  if (fs.existsSync(STORE_PATH)) return;
  const empty = { payment_intents: [], posts: [] };
  fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2));
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  const data = JSON.parse(raw || "{}");
  if (!Array.isArray(data.payment_intents)) data.payment_intents = [];
  if (!Array.isArray(data.posts)) data.posts = [];
  return data;
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function getBearer(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return "";
  return h.slice("Bearer ".length).trim();
}

async function verifyTxMatchesIntent(txSignature, intent) {
  if (BULLETIN_ALLOW_FAKE_CONFIRM) {
    return { ok: true, reason: "fake_confirm_enabled", memoMatched: true };
  }
  if (!BULLETIN_TREASURY_SOL) return { ok: false, reason: "treasury_not_configured" };
  if (!txSignature) return { ok: false, reason: "tx_signature_required" };
  try {
    const conn = new Connection(BULLETIN_SOLANA_RPC);
    const tx = await conn.getParsedTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || tx.meta.err) return { ok: false, reason: "tx_not_confirmed" };
    const minLamports = Number(intent.amount_lamports || 0);
    let transferMatched = false;
    const instructions = tx.transaction?.message?.instructions || [];
    const inner = tx.meta?.innerInstructions || [];
    const allInstructions = instructions.concat(...inner.map((g) => g.instructions || []));
    for (const ix of allInstructions) {
      if (ix.program === "system" && ix.parsed?.type === "transfer") {
        const destination = String(ix.parsed?.info?.destination || "");
        const lamports = Number(ix.parsed?.info?.lamports || 0);
        if (destination === BULLETIN_TREASURY_SOL && lamports >= minLamports) {
          transferMatched = true;
          break;
        }
      }
    }
    if (!transferMatched) return { ok: false, reason: "treasury_transfer_not_found" };
    let memoMatched = false;
    const expectedRef = String(intent.reference || "");
    if (!expectedRef) memoMatched = true;
    for (const ix of allInstructions) {
      if (ix.program === "spl-memo" && ix.parsed && typeof ix.parsed === "string") {
        if (ix.parsed.includes(expectedRef)) memoMatched = true;
      }
    }
    if (!memoMatched) return { ok: false, reason: "reference_memo_not_found" };
    return { ok: true, reason: "verified", memoMatched: true };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

async function tryHandleBulletin(req, res, pathname) {
  if (!pathname.startsWith("/api/v1/bulletin")) return false;

  if (pathname === "/api/v1/bulletin/health" && req.method === "GET") {
    const st = readStore();
    json(res, 200, {
      ok: true,
      package: "clawstr-bulletin",
      storage_path: STORE_PATH,
      treasury_solana_address: BULLETIN_TREASURY_SOL || null,
      fee_lamports: BULLETIN_FEE_LAMPORTS,
      payment_intent_count: st.payment_intents.length,
      post_count: st.posts.length,
    });
    return true;
  }

  if (pathname === "/api/v1/bulletin/payment-intent" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      json(res, 400, { error_code: "INVALID_JSON", error: "Invalid JSON body" });
      return true;
    }
    const wallet = String(body.wallet_address || "").trim();
    if (!wallet) {
      json(res, 400, { error_code: "WALLET_REQUIRED", error: "wallet_address is required" });
      return true;
    }
    const amount = Number(body.amount_lamports || BULLETIN_FEE_LAMPORTS);
    if (!Number.isFinite(amount) || amount < 1) {
      json(res, 400, { error_code: "INVALID_AMOUNT", error: "amount_lamports must be >= 1" });
      return true;
    }
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + PAYMENT_INTENT_TTL_MS).toISOString();
    const intent = {
      id: randomId("pi"),
      reference: randomId("ref"),
      wallet_address: wallet,
      amount_lamports: Math.floor(amount),
      status: "awaiting_payment",
      created_at: createdAt,
      expires_at: expiresAt,
      confirmed_at: null,
      tx_signature: null,
    };
    const st = readStore();
    st.payment_intents.push(intent);
    writeStore(st);
    json(res, 200, {
      payment_intent: intent,
      payment: {
        treasury_solana_address: BULLETIN_TREASURY_SOL || null,
        amount_lamports: intent.amount_lamports,
        reference: intent.reference,
      },
    });
    return true;
  }

  if (pathname === "/api/v1/bulletin/payment-confirm" && req.method === "POST") {
    if (!BULLETIN_ADMIN_TOKEN || getBearer(req) !== BULLETIN_ADMIN_TOKEN) {
      json(res, 401, { error_code: "UNAUTHORIZED", error: "Set BULLETIN_ADMIN_TOKEN and provide bearer token" });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      json(res, 400, { error_code: "INVALID_JSON", error: "Invalid JSON body" });
      return true;
    }
    const intentId = String(body.payment_intent_id || "").trim();
    if (!intentId) {
      json(res, 400, { error_code: "PAYMENT_INTENT_REQUIRED", error: "payment_intent_id is required" });
      return true;
    }
    const st = readStore();
    const intent = st.payment_intents.find((x) => x.id === intentId);
    if (!intent) {
      json(res, 404, { error_code: "NOT_FOUND", error: "payment intent not found" });
      return true;
    }
    const txSignature = String(body.tx_signature || "").trim();
    const verified = await verifyTxMatchesIntent(txSignature, intent);
    if (!verified.ok) {
      json(res, 402, {
        error_code: "PAYMENT_NOT_VERIFIED",
        error: "Payment transaction did not verify for this intent",
        reason: verified.reason,
      });
      return true;
    }
    intent.status = "confirmed";
    intent.confirmed_at = nowIso();
    intent.tx_signature = txSignature || intent.tx_signature || null;
    intent.verification = { method: BULLETIN_ALLOW_FAKE_CONFIRM ? "fake" : "onchain", reason: verified.reason };
    writeStore(st);
    json(res, 200, { ok: true, payment_intent: intent });
    return true;
  }

  if (pathname === "/api/v1/bulletin/post" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      json(res, 400, { error_code: "INVALID_JSON", error: "Invalid JSON body" });
      return true;
    }
    const intentId = String(body.payment_intent_id || "").trim();
    const content = String(body.content || "").trim();
    if (!intentId || !content) {
      json(res, 400, { error_code: "MISSING_FIELDS", error: "payment_intent_id and content are required" });
      return true;
    }
    const st = readStore();
    const intent = st.payment_intents.find((x) => x.id === intentId);
    if (!intent) {
      json(res, 404, { error_code: "NOT_FOUND", error: "payment intent not found" });
      return true;
    }
    if (intent.status !== "confirmed") {
      json(res, 409, { error_code: "PAYMENT_NOT_CONFIRMED", error: "payment intent is not confirmed" });
      return true;
    }
    const existing = st.posts.find((p) => p.payment_intent_id === intentId);
    if (existing) {
      json(res, 409, { error_code: "ALREADY_POSTED", error: "payment intent already used for a post", post: existing });
      return true;
    }
    const post = {
      id: randomId("post"),
      payment_intent_id: intentId,
      content,
      status: "accepted",
      nostr_event_id: null,
      created_at: nowIso(),
    };
    st.posts.push(post);
    writeStore(st);
    json(res, 200, { ok: true, post });
    return true;
  }

  json(res, 404, { error_code: "NOT_FOUND", error: "Unknown bulletin route" });
  return true;
}

module.exports = { tryHandleBulletin };
