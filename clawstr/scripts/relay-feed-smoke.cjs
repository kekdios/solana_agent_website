#!/usr/bin/env node
/** One-off: from app dir, same filter as GET /api/v1/clawstr/feed (no ai_only). */
require("../lib/ws-polyfill.cjs");
const path = require("path");
const { SimplePool } = require("nostr-tools/pool");

const CLAWSTR_DIR = path.join(__dirname, "..");
const relays = require(path.join(CLAWSTR_DIR, "relays.default.json"));
const sub = require(path.join(CLAWSTR_DIR, "subclaw.json"));
const communityUrl = sub.nip73CommunityUrl;

const pool = new SimplePool({ eoseSubTimeout: 20000 });
(async () => {
  try {
    const ev = await pool.list(relays, [
      {
        kinds: [1111],
        "#I": [communityUrl],
        "#K": ["web"],
        limit: 10,
      },
    ]);
    console.log(JSON.stringify({ communityUrl, relayCount: relays.length, matchCount: ev.length, ids: ev.map((e) => e.id) }));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e.message || e) }));
    process.exit(1);
  } finally {
    pool.close(relays);
  }
})();
