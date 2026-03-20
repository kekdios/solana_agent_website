/**
 * Thin HTTP mount for Clawstr — see docs/TOWN_CRIER_PLAN.md §5.
 * Routes: GET …/health, …/feed (?ai_only=1), …/communities
 */
require("./lib/ws-polyfill.cjs");
const fs = require("fs");
const path = require("path");
const { nip19, getPublicKey } = require("nostr-tools");
const { SimplePool } = require("nostr-tools/pool");
const { loadClawstrRelatedEnv } = require("./lib/load-env.cjs");

const CLAWSTR_DIR = __dirname;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function json(res, status, body) {
  // Use statusCode only: api-server already set Content-Type / CORS before calling us;
  // res.writeHead() after setHeader() can throw on some Node versions (empty reply to client).
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function secretKeyFromNsec(nsec) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("invalid nsec");
  return decoded.data;
}

function npubFromEnv() {
  const nsec = process.env.CLAWSTR_NSEC;
  const npubEnv = (process.env.CLAWSTR_NPUB || "").trim();
  if (npubEnv) return npubEnv;
  if (!nsec) return null;
  try {
    const pk = getPublicKey(secretKeyFromNsec(nsec));
    return nip19.npubEncode(pk);
  } catch (_) {
    return null;
  }
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} pathname
 * @param {URL} url
 * @returns {Promise<boolean>} true if this module handled the request
 */
async function tryHandleClawstr(req, res, pathname, url) {
  if (!pathname.startsWith("/api/v1/clawstr")) return false;

  loadClawstrRelatedEnv();

  const sub = readJson(path.join(CLAWSTR_DIR, "subclaw.json"));
  const communityUrl = sub.nip73CommunityUrl;
  const relays = readJson(path.join(CLAWSTR_DIR, "relays.default.json"));

  if (pathname === "/api/v1/clawstr/health" && req.method === "GET") {
    const nsec = !!(process.env.CLAWSTR_NSEC && process.env.CLAWSTR_NSEC.trim());
    json(res, 200, {
      ok: true,
      package: "clawstr",
      subclaw_slug: sub.slug,
      nip73_community_url: communityUrl,
      npub: npubFromEnv(),
      signing_configured: nsec,
    });
    return true;
  }

  if (pathname === "/api/v1/clawstr/feed" && req.method === "GET") {
    let limit = Number(url.searchParams.get("limit") || "30");
    if (!Number.isFinite(limit) || limit < 1) limit = 30;
    if (limit > 100) limit = 100;

    const aiOnly = /^(1|true|yes)$/i.test(String(url.searchParams.get("ai_only") || ""));

    const filter = {
      kinds: [1111],
      "#I": [communityUrl],
      "#K": ["web"],
      limit,
    };
    // Clawstr / NIP-32: AI-only feeds (see https://clawstr.com/docs/technical)
    if (aiOnly) {
      filter["#l"] = ["ai"];
      filter["#L"] = ["agent"];
    }

    const pool = new SimplePool({ eoseSubTimeout: 12000 });
    try {
      const events = await pool.list(relays, [filter]);
      events.sort((a, b) => b.created_at - a.created_at);
      const posts = events.map((e) => ({
        id: e.id,
        pubkey: e.pubkey,
        created_at: e.created_at,
        content: e.content,
        tags: e.tags,
      }));
      json(res, 200, {
        subclaw: sub.slug,
        nip73_community_url: communityUrl,
        ai_only: aiOnly,
        count: posts.length,
        posts,
      });
    } catch (e) {
      json(res, 502, {
        error_code: "CLAWSTR_FEED_UPSTREAM",
        error: String(e.message || e),
      });
    } finally {
      pool.close(relays);
    }
    return true;
  }

  if (pathname === "/api/v1/clawstr/communities" && req.method === "GET") {
    try {
      const data = readJson(path.join(CLAWSTR_DIR, "popular-communities.json"));
      json(res, 200, data);
    } catch (e) {
      json(res, 500, {
        error_code: "CLAWSTR_COMMUNITIES_READ",
        error: String(e.message || e),
      });
    }
    return true;
  }

  json(res, 404, { error_code: "NOT_FOUND", error: "Unknown Clawstr route" });
  return true;
}

module.exports = { tryHandleClawstr };
