const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("./lib/ws-polyfill.cjs");
const { Connection } = require("@solana/web3.js");
const { finishEvent, nip19 } = require("nostr-tools");
const { SimplePool } = require("nostr-tools/pool");
const { getDb, DB_PATH } = require("./bulletin-db.cjs");

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
const CLAWSTR_AGENT_CODE = (process.env.CLAWSTR_AGENT_CODE || "").trim();
const BULLETIN_SKIP_NOSTR_PUBLISH = /^(1|true|yes)$/i.test(String(process.env.BULLETIN_SKIP_NOSTR_PUBLISH || ""));
const BULLETIN_POST_MAX_LENGTH = Math.max(1, Number(process.env.BULLETIN_POST_MAX_LENGTH || "1000"));
const BULLETIN_AGENT_RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.BULLETIN_AGENT_RATE_LIMIT_PER_MIN || "5"));
const BULLETIN_PAID_RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.BULLETIN_PAID_RATE_LIMIT_PER_MIN || "10"));
const SUBCLAW = JSON.parse(fs.readFileSync(path.join(__dirname, "subclaw.json"), "utf8"));
const RELAYS = JSON.parse(fs.readFileSync(path.join(__dirname, "relays.default.json"), "utf8"));
const RATE_WINDOW_MS = 60 * 1000;
const RATE_BUCKETS = new Map();
const MODERATION_LOG_PATH = path.join(__dirname, "bulletin-moderation.log");

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

function getBearer(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return "";
  return h.slice("Bearer ".length).trim();
}

function getAgentCode(req, body) {
  const headerCode = String(req.headers["x-clawstr-agent-code"] || "").trim();
  if (headerCode) return headerCode;
  return String((body && body.agent_code) || "").trim();
}

function getClientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").trim();
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown");
}

function checkRateLimit(key, limit, nowMs) {
  const existing = RATE_BUCKETS.get(key);
  let bucket = existing;
  if (!bucket || nowMs - bucket.windowStartMs >= RATE_WINDOW_MS) {
    bucket = { windowStartMs: nowMs, count: 0 };
    RATE_BUCKETS.set(key, bucket);
  }
  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStartMs + RATE_WINDOW_MS - nowMs) / 1000));
    return { ok: false, retryAfterSeconds };
  }
  bucket.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}

function writeModerationLog(entry) {
  const line = JSON.stringify(entry) + "\n";
  fs.appendFile(MODERATION_LOG_PATH, line, (err) => {
    if (err) console.error("[bulletin-moderation-log]", err);
  });
}

function getSecretKeyFromNsec(nsec) {
  const decoded = nip19.decode(String(nsec || "").trim());
  if (decoded.type !== "nsec") throw new Error("CLAWSTR_NSEC must be nsec");
  return decoded.data;
}

async function publishBulletinPost(content) {
  if (BULLETIN_SKIP_NOSTR_PUBLISH) {
    return { eventId: `test_${randomId("nostr")}`, publishedAt: nowIso() };
  }
  const nsec = String(process.env.CLAWSTR_NSEC || "").trim();
  if (!nsec) throw new Error("CLAWSTR_NSEC not configured");
  const sk = getSecretKeyFromNsec(nsec);
  const unsigned = {
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["I", SUBCLAW.nip73CommunityUrl],
      ["K", "web"],
      ["i", SUBCLAW.nip73CommunityUrl],
      ["k", "web"],
      ["L", "agent"],
      ["l", "ai", "agent"],
    ],
    content,
  };
  const ev = finishEvent(unsigned, sk);
  const pool = new SimplePool({ eoseSubTimeout: 10000 });
  try {
    const publishPromises = pool.publish(RELAYS, ev);
    await Promise.all(publishPromises);
    return { eventId: ev.id, publishedAt: nowIso() };
  } finally {
    pool.close(RELAYS);
  }
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
    const db = getDb();
    const paymentIntentCount = Number(db.prepare("SELECT COUNT(*) as c FROM payment_intents").get().c || 0);
    const postCount = Number(db.prepare("SELECT COUNT(*) as c FROM posts").get().c || 0);
    json(res, 200, {
      ok: true,
      package: "clawstr-bulletin",
      storage_path: DB_PATH,
      treasury_solana_address: BULLETIN_TREASURY_SOL || null,
      fee_lamports: BULLETIN_FEE_LAMPORTS,
      payment_intent_count: paymentIntentCount,
      post_count: postCount,
      agent_code_configured: !!CLAWSTR_AGENT_CODE,
    });
    return true;
  }

  if (pathname === "/api/v1/bulletin/feed" && req.method === "GET") {
    const limitRaw = Number((new URL(req.url, "http://localhost")).searchParams.get("limit") || 20);
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));
    const db = getDb();
    const posts = db
      .prepare(
        `SELECT id, payment_intent_id, content, status, nostr_event_id, created_at, publish_error, published_at
           FROM posts
          ORDER BY datetime(COALESCE(published_at, created_at)) DESC
          LIMIT ?`
      )
      .all(limit);
    json(res, 200, {
      ok: true,
      count: posts.length,
      limit,
      posts,
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
    const db = getDb();
    db.prepare(
      `INSERT INTO payment_intents
       (id, reference, wallet_address, amount_lamports, status, created_at, expires_at, confirmed_at, tx_signature, verification_method, verification_reason)
       VALUES (@id, @reference, @wallet_address, @amount_lamports, @status, @created_at, @expires_at, @confirmed_at, @tx_signature, NULL, NULL)`
    ).run(intent);
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
    const db = getDb();
    const intent = db.prepare("SELECT * FROM payment_intents WHERE id = ?").get(intentId);
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
    const confirmedAt = nowIso();
    const verificationMethod = BULLETIN_ALLOW_FAKE_CONFIRM ? "fake" : "onchain";
    db.prepare(
      `UPDATE payment_intents
         SET status = 'confirmed',
             confirmed_at = ?,
             tx_signature = COALESCE(?, tx_signature),
             verification_method = ?,
             verification_reason = ?
       WHERE id = ?`
    ).run(confirmedAt, txSignature || null, verificationMethod, verified.reason, intentId);
    const updated = db.prepare("SELECT * FROM payment_intents WHERE id = ?").get(intentId);
    json(res, 200, { ok: true, payment_intent: updated });
    return true;
  }

  if (pathname === "/api/v1/bulletin/post" && req.method === "POST") {
    const clientIp = getClientIp(req);
    const requestTs = nowIso();
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, outcome: "invalid_json", status: 400 });
      json(res, 400, { error_code: "INVALID_JSON", error: "Invalid JSON body" });
      return true;
    }
    const content = String(body.content || "").trim();
    if (!content) {
      writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, outcome: "missing_content", status: 400 });
      json(res, 400, { error_code: "MISSING_FIELDS", error: "content is required" });
      return true;
    }
    if (content.length > BULLETIN_POST_MAX_LENGTH) {
      writeModerationLog({
        ts: requestTs,
        route: pathname,
        ip: clientIp,
        outcome: "content_too_long",
        status: 400,
        content_length: content.length,
      });
      json(res, 400, { error_code: "CONTENT_TOO_LONG", error: `content exceeds ${BULLETIN_POST_MAX_LENGTH} characters` });
      return true;
    }
    const providedAgentCode = getAgentCode(req, body);
    const paymentIntentId = String(body.payment_intent_id || "").trim();
    const txSignature = String(body.tx_signature || "").trim();
    const db = getDb();
    let intentId = "";
    const authMode = providedAgentCode ? "agent_code" : "paid";
    const nowMs = Date.now();
    const rateLimit = checkRateLimit(
      `post:${authMode}:${clientIp}`,
      authMode === "agent_code" ? BULLETIN_AGENT_RATE_LIMIT_PER_MIN : BULLETIN_PAID_RATE_LIMIT_PER_MIN,
      nowMs
    );
    if (!rateLimit.ok) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      writeModerationLog({
        ts: requestTs,
        route: pathname,
        ip: clientIp,
        auth_mode: authMode,
        outcome: "rate_limited",
        status: 429,
        retry_after_seconds: rateLimit.retryAfterSeconds,
      });
      json(res, 429, {
        error_code: "RATE_LIMITED",
        error: "Too many bulletin post attempts. Try again shortly.",
        retry_after_seconds: rateLimit.retryAfterSeconds,
      });
      return true;
    }
    if (providedAgentCode) {
      if (!CLAWSTR_AGENT_CODE) {
        writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "service_config_missing_agent_code", status: 503 });
        json(res, 503, { error_code: "SERVICE_CONFIG", error: "CLAWSTR_AGENT_CODE is not configured" });
        return true;
      }
      if (providedAgentCode !== CLAWSTR_AGENT_CODE) {
        writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "invalid_agent_code", status: 401 });
        json(res, 401, { error_code: "INVALID_AGENT_CODE", error: "Valid agent code required for posting" });
        return true;
      }
      intentId = randomId("agent_post_auth");
      const createdAt = nowIso();
      const authRow = {
        id: intentId,
        reference: randomId("agent_ref"),
        wallet_address: "agent",
        amount_lamports: 0,
        status: "confirmed",
        created_at: createdAt,
        expires_at: createdAt,
        confirmed_at: createdAt,
        tx_signature: null,
      };
      db.prepare(
        `INSERT INTO payment_intents
         (id, reference, wallet_address, amount_lamports, status, created_at, expires_at, confirmed_at, tx_signature, verification_method, verification_reason)
         VALUES (@id, @reference, @wallet_address, @amount_lamports, @status, @created_at, @expires_at, @confirmed_at, @tx_signature, 'agent_code', 'shared_code_valid')`
      ).run(authRow);
    } else {
      if (!paymentIntentId) {
        writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "missing_post_auth", status: 400 });
        json(res, 400, { error_code: "MISSING_FIELDS", error: "agent_code or payment_intent_id is required" });
        return true;
      }
      const intent = db.prepare("SELECT * FROM payment_intents WHERE id = ?").get(paymentIntentId);
      if (!intent) {
        writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "payment_intent_not_found", status: 404, payment_intent_id: paymentIntentId });
        json(res, 404, { error_code: "NOT_FOUND", error: "payment intent not found" });
        return true;
      }
      if (intent.status !== "confirmed") {
        if (!txSignature) {
          writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "tx_signature_required", status: 400, payment_intent_id: paymentIntentId });
          json(res, 400, { error_code: "TX_SIGNATURE_REQUIRED", error: "tx_signature is required when payment intent is not yet confirmed" });
          return true;
        }
        const verified = await verifyTxMatchesIntent(txSignature, intent);
        if (!verified.ok) {
          writeModerationLog({
            ts: requestTs,
            route: pathname,
            ip: clientIp,
            auth_mode: authMode,
            outcome: "payment_not_verified",
            status: 402,
            payment_intent_id: paymentIntentId,
            reason: verified.reason,
          });
          json(res, 402, {
            error_code: "PAYMENT_NOT_VERIFIED",
            error: "Payment transaction did not verify for this intent",
            reason: verified.reason,
          });
          return true;
        }
        const confirmedAt = nowIso();
        db.prepare(
          `UPDATE payment_intents
             SET status = 'confirmed',
                 confirmed_at = ?,
                 tx_signature = COALESCE(?, tx_signature),
                 verification_method = ?,
                 verification_reason = ?
           WHERE id = ?`
        ).run(confirmedAt, txSignature || null, "onchain_post", verified.reason, paymentIntentId);
      }
      const existing = db.prepare("SELECT * FROM posts WHERE payment_intent_id = ?").get(paymentIntentId);
      if (existing) {
        writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "already_posted", status: 409, payment_intent_id: paymentIntentId, post_id: existing.id });
        json(res, 409, { error_code: "ALREADY_POSTED", error: "payment intent already used for a post", post: existing });
        return true;
      }
      intentId = paymentIntentId;
    }
    if (!intentId) {
      writeModerationLog({ ts: requestTs, route: pathname, ip: clientIp, auth_mode: authMode, outcome: "missing_intent_after_auth", status: 503 });
      json(res, 503, { error_code: "SERVICE_CONFIG", error: "CLAWSTR_AGENT_CODE is not configured" });
      return true;
    }
    const post = {
      id: randomId("post"),
      payment_intent_id: intentId,
      content,
      status: "published",
      nostr_event_id: null,
      created_at: nowIso(),
      publish_error: null,
      published_at: null,
    };
    let published;
    try {
      published = await publishBulletinPost(content);
      post.nostr_event_id = published.eventId;
      post.published_at = published.publishedAt;
    } catch (e) {
      post.status = "publish_failed";
      post.publish_error = String(e.message || e);
    }
    db.prepare(
      `INSERT INTO posts (id, payment_intent_id, content, status, nostr_event_id, created_at, publish_error, published_at)
       VALUES (@id, @payment_intent_id, @content, @status, @nostr_event_id, @created_at, @publish_error, @published_at)`
    ).run(post);
    if (post.status === "publish_failed") {
      writeModerationLog({
        ts: requestTs,
        route: pathname,
        ip: clientIp,
        auth_mode: authMode,
        outcome: "publish_failed",
        status: 502,
        post_id: post.id,
        payment_intent_id: post.payment_intent_id,
        publish_error: post.publish_error,
      });
      json(res, 502, { error_code: "NOSTR_PUBLISH_FAILED", error: post.publish_error, post });
      return true;
    }
    writeModerationLog({
      ts: requestTs,
      route: pathname,
      ip: clientIp,
      auth_mode: authMode,
      outcome: "published",
      status: 200,
      post_id: post.id,
      payment_intent_id: post.payment_intent_id,
      nostr_event_id: post.nostr_event_id,
      content_length: content.length,
    });
    json(res, 200, { ok: true, post });
    return true;
  }

  json(res, 404, { error_code: "NOT_FOUND", error: "Unknown bulletin route" });
  return true;
}

module.exports = { tryHandleBulletin };
