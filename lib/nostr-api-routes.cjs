/**
 * HTTP handlers for GET /api/nostr/feed and GET /api/nostr/posts (agent-compatible).
 */
require("../nostr/lib/ws-polyfill.cjs");
const { loadNostrRelatedEnv } = require("../nostr/lib/load-env.cjs");
const { fetchAgentKind1111Posts, fetchLatestKind1111FeedPosts } = require("./nostr-public-feed.cjs");

function json(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} pathname
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function tryHandleNostr(req, res, pathname, url) {
  if (!pathname.startsWith("/api/nostr")) return false;

  loadNostrRelatedEnv();

  if (pathname === "/api/nostr/posts" && req.method === "GET") {
    try {
      const limit = url.searchParams.get("limit");
      const until = url.searchParams.get("until");
      const out = await fetchAgentKind1111Posts(process.env, {
        limit: limit != null && limit !== "" ? Number(limit) : 100,
        until: until != null && until !== "" ? Number(until) : undefined,
      });
      json(res, 200, out);
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (pathname === "/api/nostr/feed" && req.method === "GET") {
    try {
      const limit = url.searchParams.get("limit");
      const until = url.searchParams.get("until");
      const aiOnlyRaw = url.searchParams.get("ai_only");
      const topicParam = url.searchParams.get("topic_labels");
      let topic_labels = undefined;
      if (topicParam != null && String(topicParam).trim() !== "") {
        topic_labels = String(topicParam)
          .split(/[,;\s]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
      }
      const out = await fetchLatestKind1111FeedPosts(process.env, {
        limit: limit != null && limit !== "" ? Number(limit) : 10,
        until: until != null && until !== "" ? Number(until) : undefined,
        ai_only: aiOnlyRaw == null ? true : aiOnlyRaw === "1" || aiOnlyRaw === "true",
        topic_labels,
      });
      json(res, 200, out);
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  json(res, 404, { ok: false, error_code: "NOT_FOUND", error: "Unknown Nostr API route" });
  return true;
}

module.exports = { tryHandleNostr };
