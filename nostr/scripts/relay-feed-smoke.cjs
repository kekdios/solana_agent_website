#!/usr/bin/env node
/** One-off: query kind 1111 for NIP-73 community in subclaw.json (NIP-73 #I / #K web). */
require("../lib/ws-polyfill.cjs");
const path = require("path");
const { SimplePool } = require("nostr-tools/pool");

const NOSTR_DIR = path.join(__dirname, "..");
const relays = require(path.join(NOSTR_DIR, "relays.default.json"));
const sub = require(path.join(NOSTR_DIR, "subclaw.json"));
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
