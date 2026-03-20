#!/usr/bin/env node
/**
 * Publish a Clawstr-shaped kind 1111 top-level post to recommended relays (local spike).
 *
 * Expects CLAWSTR_NSEC in repo-root .env.clawstr (or .env). Subclaw: clawstr/subclaw.json
 *
 *   npm run clawstr:spike-publish
 *   npm run clawstr:spike-publish -- --dry-run
 *   npm run clawstr:spike-publish -- --content "Hello"
 *   npm run clawstr:spike-publish -- --ai
 */
require("../lib/ws-polyfill.cjs");
const fs = require("fs");
const path = require("path");
const { finishEvent, nip19 } = require("nostr-tools");
const { SimplePool } = require("nostr-tools/pool");
const { loadClawstrRelatedEnv, REPO_ROOT } = require("../lib/load-env.cjs");

const CLAWSTR_DIR = path.join(__dirname, "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function parseArgs(argv) {
  const out = { dryRun: false, aiLabels: false, content: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--ai") out.aiLabels = true;
    else if (a === "--content") {
      out.content = argv[++i];
      if (out.content == null) {
        console.error("Missing value after --content");
        process.exit(1);
      }
    } else if (a === "-h" || a === "--help") {
      console.log(`Usage:
  npm run clawstr:spike-publish
  npm run clawstr:spike-publish -- --dry-run
  npm run clawstr:spike-publish -- --content "Your text"
  npm run clawstr:spike-publish -- --ai   # add NIP-32 AI agent labels

Loads CLAWSTR_NSEC from .env.clawstr (or .env). Uses clawstr/subclaw.json + clawstr/relays.default.json.`);
      process.exit(0);
    }
  }
  return out;
}

function secretKeyFromNsec(nsec) {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error("CLAWSTR_NSEC must be a bech32 nsec");
  }
  return decoded.data;
}

async function main() {
  loadClawstrRelatedEnv();
  const opts = parseArgs(process.argv.slice(2));

  const nsec = process.env.CLAWSTR_NSEC;
  if (!nsec) {
    console.error(
      "Missing CLAWSTR_NSEC. Set it in .env.clawstr (see npm run clawstr:generate-account)."
    );
    process.exit(1);
  }

  const sub = readJson(path.join(CLAWSTR_DIR, "subclaw.json"));
  if (!sub.nip73CommunityUrl || typeof sub.nip73CommunityUrl !== "string") {
    console.error("Invalid clawstr/subclaw.json: expected nip73CommunityUrl");
    process.exit(1);
  }
  const communityUrl = sub.nip73CommunityUrl;

  const relays = readJson(path.join(CLAWSTR_DIR, "relays.default.json"));
  if (!Array.isArray(relays) || relays.length === 0) {
    console.error("Invalid clawstr/relays.default.json");
    process.exit(1);
  }

  const defaultContent = `Solana Agent · Clawstr spike (${sub.slug}) · ${new Date().toISOString()}`;
  const content = opts.content != null ? String(opts.content) : defaultContent;

  const tags = [
    ["I", communityUrl],
    ["K", "web"],
    ["i", communityUrl],
    ["k", "web"],
  ];
  if (opts.aiLabels) {
    tags.push(["L", "agent"], ["l", "ai", "agent"]);
  }

  const sk = secretKeyFromNsec(nsec.trim());
  const unsigned = {
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };

  const event = finishEvent(unsigned, sk);

  console.log("Subclaw:", communityUrl);
  console.log("Kind: 1111 · AI labels:", opts.aiLabels);
  console.log("Event id:", event.id);
  console.log("Content:", content);
  console.log("Relays:", relays.join(", "));

  if (opts.dryRun) {
    console.log("\n--dry-run: not publishing.");
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  const pool = new SimplePool({ eoseSubTimeout: 10000 });
  try {
    const publishPromises = pool.publish(relays, event);
    const statuses = await Promise.all(publishPromises);
    console.log("\nPublish results (per relay order):", statuses);
    const found = await pool.list(relays, [{ ids: [event.id], limit: 1 }]);
    if (found.length) {
      console.log("Verified: event returned from at least one relay.");
    } else {
      console.warn("Could not re-fetch event by id immediately (may still propagate).");
    }
  } finally {
    pool.close(relays);
  }

  console.log("\nShare:", `https://njump.me/${event.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
