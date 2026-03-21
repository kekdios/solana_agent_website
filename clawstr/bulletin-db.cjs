const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.BULLETIN_DB_PATH
  ? path.resolve(process.env.BULLETIN_DB_PATH)
  : path.join(__dirname, "bulletin.sqlite");

let dbInstance = null;

function getDb() {
  if (dbInstance) return dbInstance;
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      wallet_address TEXT NOT NULL,
      amount_lamports INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      confirmed_at TEXT,
      tx_signature TEXT UNIQUE,
      verification_method TEXT,
      verification_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      payment_intent_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      nostr_event_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id)
    );
  `);
  const postCols = new Set(db.prepare("PRAGMA table_info(posts)").all().map((r) => r.name));
  if (!postCols.has("publish_error")) db.exec("ALTER TABLE posts ADD COLUMN publish_error TEXT");
  if (!postCols.has("published_at")) db.exec("ALTER TABLE posts ADD COLUMN published_at TEXT");
  dbInstance = db;
  return dbInstance;
}

module.exports = { getDb, DB_PATH };
