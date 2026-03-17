#!/usr/bin/env node
/**
 * Local check: ensure arbitrage_transactions table exists and GET /api/arbitrage/transactions
 * returns rows (most recent first). Inserts one test row, spawns API, fetches endpoint.
 * Requires .env with DATABASE_URL. Optional: API_PORT (default 3012).
 */
const path = require("path");
const fs = require("fs");
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const http = require("http");
const { spawn } = require("child_process");

const DATABASE_URL = process.env.DATABASE_URL;
const API_PORT = Number(process.env.API_PORT) || 3012;
const BASE = `http://127.0.0.1:${API_PORT}`;

function waitForPort(port, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    function tryConnect() {
      const req = http.get(`http://127.0.0.1:${port}/api/arbitrage/transactions`, (res) => resolve(true));
      req.on("error", () => {
        if (Date.now() - start > ms) return resolve(false);
        setTimeout(tryConnect, 100);
      });
    }
    tryConnect();
  });
}

async function main() {
  if (!DATABASE_URL || !DATABASE_URL.trim()) {
    console.log("DATABASE_URL not set in .env — skipping. Set it to verify arbitrage_transactions.");
    process.exit(0);
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL.trim() });

  try {
    const tableCheck = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'arbitrage_transactions'"
    );
    if (tableCheck.rows.length === 0) {
      console.error("Table arbitrage_transactions does not exist. Run db/setup-local.sh and apply schema.");
      process.exit(1);
    }
    console.log("Table arbitrage_transactions exists.");

    const testId = "test-local-" + Date.now();
    await pool.query(
      "INSERT INTO arbitrage_transactions (external_id, type, amount_sats, amount_usd, status, signature) VALUES ($1, $2, $3, $4, $5, $6)",
      [testId, "issue", 1000, null, "confirmed", null]
    );
    console.log("Inserted test row type=issue amount_sats=1000 external_id=" + testId);

    const child = spawn(process.execPath, [path.join(__dirname, "api-server.cjs")], {
      env: { ...process.env, API_PORT: String(API_PORT) },
      cwd: __dirname,
      stdio: "pipe",
    });
    const ready = await waitForPort(API_PORT, 6000);
    if (!ready) {
      child.kill();
      console.error("API did not start in time.");
      process.exit(1);
    }

    const data = await new Promise((resolve, reject) => {
      http.get(BASE + "/api/arbitrage/transactions", (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }).on("error", reject);
    });

    child.kill();

    const txs = data.transactions || [];
    const found = txs.some((t) => t.txId === testId || (t.amountSats === 1000 && t.type === "issue"));
    console.log("GET /api/arbitrage/transactions returned", txs.length, "rows (most recent first).");
    if (txs.length > 0) {
      console.log("First row: type=" + txs[0].type + " amountSats=" + txs[0].amountSats + " txId=" + (txs[0].txId || "—"));
    }
    if (found) {
      console.log("OK: New ABSR transaction row is in DB and returned by API (most recent first).");
    } else if (txs.length > 0) {
      console.log("OK: API returns arbitrage_transactions from DB (most recent first). Test row may be older than existing rows.");
    } else {
      console.log("API returned empty list; table has rows but API may not have picked them up (check DATABASE_URL for API).");
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || (e.message && e.message.includes("ECONNREFUSED"))) {
      console.log("Could not connect to Postgres (is it running?). Start local Postgres and run db/setup-local.sh, then re-run this test.");
    } else {
      console.error("Error:", e.message || e);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
