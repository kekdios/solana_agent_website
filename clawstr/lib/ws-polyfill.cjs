/**
 * nostr-tools SimplePool uses global WebSocket (Node 21+). DigitalOcean image uses Node 18.
 */
if (typeof globalThis.WebSocket === "undefined") {
  try {
    globalThis.WebSocket = require("ws");
  } catch (_) {
    /* ws not installed — Clawstr relay calls will fail at runtime */
  }
}
