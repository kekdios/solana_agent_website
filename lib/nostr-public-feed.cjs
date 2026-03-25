/**
 * Kind-1111 relay reads for public site (same contract as agent server /api/nostr/*).
 * Uses NOSTR_* env; falls back to legacy CLAWSTR_* when NOSTR_* unset.
 */
const { SimplePool } = require("nostr-tools/pool");
const { getPublicKey, nip19 } = require("nostr-tools");

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

const DEFAULT_FEED_TOPIC_LABELS = Object.freeze(["ai", "blockchain", "defi"]);

function envStr(env, k) {
  return String(env?.[k] ?? process.env[k] ?? "").trim();
}

function getRelayList(env = {}) {
  const raw = envStr(env, "NOSTR_RELAYS");
  if (!raw) return [...DEFAULT_RELAYS];
  const relays = raw
    .split(/[,\s;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return relays.length ? relays : [...DEFAULT_RELAYS];
}

function getNsec(env = {}) {
  const n = envStr(env, "NOSTR_NSEC");
  if (n) return n;
  return envStr(env, "CLAWSTR_NSEC");
}

function getNpubFromEnv(env = {}) {
  const n = envStr(env, "NOSTR_NPUB");
  if (n) return n;
  const legacy = envStr(env, "CLAWSTR_NPUB");
  return legacy || null;
}

function decodeSecretKey(nsec) {
  if (!nsec) return null;
  try {
    const dec = nip19.decode(nsec);
    if (dec.type !== "nsec") return null;
    return dec.data;
  } catch {
    return null;
  }
}

async function queryEvents({ relays, filter, timeoutMs = 18000 }) {
  const pool = new SimplePool({ eoseSubTimeout: timeoutMs });
  try {
    const events = await pool.list(relays, [filter]);
    return { ok: true, events: Array.isArray(events) ? events : [] };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), events: [] };
  } finally {
    try {
      pool.close(relays);
    } catch (_) {}
  }
}

function getAgentPubkeyHexFromEnv(env = {}) {
  const nsec = getNsec(env);
  const sk = decodeSecretKey(nsec);
  if (sk) return getPublicKey(sk);
  const npub = getNpubFromEnv(env);
  if (npub) {
    try {
      const d = nip19.decode(npub);
      if (d.type === "npub") return d.data;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function eventHasAnyTopicLabel(ev, labels) {
  if (!labels || labels.length === 0) return true;
  const set = new Set(labels.map((x) => String(x).toLowerCase()));
  return (ev.tags || []).some(
    (t) => Array.isArray(t) && t[0] === "l" && set.has(String(t[1] || "").toLowerCase())
  );
}

function normalizeTopicLabelsInput(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const out = raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    return out.length ? out : null;
  }
  if (typeof raw === "string") {
    const out = raw
      .split(/[,;\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    return out.length ? out : null;
  }
  return null;
}

/**
 * Fetch kind 1111 posts authored by configured identity (NOSTR_NSEC / NOSTR_NPUB or legacy CLAWSTR_*).
 */
async function fetchAgentKind1111Posts(env = {}, opts = {}) {
  const limitRaw = opts.limit != null ? Number(opts.limit) : 100;
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));
  const until =
    opts.until != null && Number.isFinite(Number(opts.until)) ? Math.floor(Number(opts.until)) : undefined;

  const pubkeyHex = getAgentPubkeyHexFromEnv(env);
  if (!pubkeyHex) {
    return {
      ok: false,
      code: "NO_IDENTITY",
      error: "Set NOSTR_NSEC or NOSTR_NPUB in .env / secrets to load agent posts.",
    };
  }

  const relays = getRelayList(env);
  const filter = { kinds: [1111], authors: [pubkeyHex], limit };
  if (until != null) filter.until = until;

  const q = await queryEvents({ relays, filter, timeoutMs: 18000 });
  if (!q.ok) {
    return { ok: false, error: q.error || "Relay query failed" };
  }

  let events = [...(q.events || [])].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  events = events.slice(0, limit);

  const posts = events.map((ev) => ({
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    content: ev.content != null ? String(ev.content) : "",
    kind: ev.kind,
  }));

  const oldestTs = events.length ? Number(events[events.length - 1].created_at) : null;
  const next_until =
    events.length > 0 && events.length === limit && oldestTs != null && Number.isFinite(oldestTs)
      ? oldestTs - 1
      : null;

  return {
    ok: true,
    npub: nip19.npubEncode(pubkeyHex),
    pubkey: pubkeyHex,
    relays,
    posts,
    limit,
    until: until ?? null,
    next_until,
  };
}

/**
 * Global kind-1111 feed with optional topic OR filter on `l` tags (default: ai | blockchain | defi).
 */
async function fetchLatestKind1111FeedPosts(env = {}, opts = {}) {
  const limitRaw = opts.limit != null ? Number(opts.limit) : 10;
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
  const until =
    opts.until != null && Number.isFinite(Number(opts.until)) ? Math.floor(Number(opts.until)) : undefined;
  const aiOnly = opts.ai_only === true || opts.ai_only === "true" || opts.ai_only === 1;
  const topicLabels =
    normalizeTopicLabelsInput(opts.topic_labels) ?? (aiOnly ? [...DEFAULT_FEED_TOPIC_LABELS] : null);

  const relays = getRelayList(env);
  const filter = { kinds: [1111], limit: Math.min(400, limit * 6) };
  if (until != null) filter.until = until;

  const q = await queryEvents({ relays, filter, timeoutMs: 18000 });
  if (!q.ok) return { ok: false, error: q.error || "Relay query failed" };

  let events = [...(q.events || [])].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  if (aiOnly) {
    events = events.filter((ev) => eventHasAnyTopicLabel(ev, topicLabels));
  }
  events = events.slice(0, limit);

  const posts = events.map((ev) => ({
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    content: ev.content != null ? String(ev.content) : "",
    kind: ev.kind,
  }));

  const oldestTs = events.length ? Number(events[events.length - 1].created_at) : null;
  const next_until =
    events.length > 0 && events.length === limit && oldestTs != null && Number.isFinite(oldestTs)
      ? oldestTs - 1
      : null;

  return {
    ok: true,
    relays,
    posts,
    limit,
    until: until ?? null,
    next_until,
    ai_only: aiOnly,
    topic_labels: aiOnly ? topicLabels : null,
  };
}

module.exports = {
  DEFAULT_FEED_TOPIC_LABELS,
  fetchAgentKind1111Posts,
  fetchLatestKind1111FeedPosts,
  getAgentPubkeyHexFromEnv,
};
