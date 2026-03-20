#!/usr/bin/env node
/**
 * Test API endpoints without doing any real transaction.
 * Run from website/: node test-api-no-tx.js
 */
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, BASE);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    if (body) req.setHeader("Content-Type", "application/json"), req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForPort(port, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    function tryConnect() {
      const req = http.get(`http://127.0.0.1:${port}/api/reserves`, (res) => resolve());
      req.on("error", () => {
        if (Date.now() - start > ms) return resolve();
        setTimeout(tryConnect, 100);
      });
    }
    tryConnect();
  });
}

async function run() {
  const serverPath = path.join(__dirname, "api-server.cjs");
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, API_PORT: String(PORT) },
    cwd: __dirname,
    stdio: "pipe",
  });
  let exited = false;
  child.on("exit", (code) => { exited = true; if (code != null && code !== 0) console.log("Server exit", code); });

  await waitForPort(PORT, 5000);
  if (exited) {
    console.log("Server exited before tests");
    process.exit(1);
  }

  const results = [];
  function ok(name, r) {
    const pass = r.status >= 200 && r.status < 300;
    results.push({ name, pass, status: r.status });
    console.log(pass ? "  OK" : "  FAIL", r.status, name);
  }

  try {
    console.log("\n--- Read-only GET ---");
    ok("GET /api/reserves", await request("GET", "/api/reserves"));
    ok("GET /api/proof", await request("GET", "/api/proof"));
    ok("GET /api/explorer/treasury", await request("GET", "/api/explorer/treasury"));
    ok("GET /api/arbitrage/summary", await request("GET", "/api/arbitrage/summary"));
    ok("GET /api/swap/min", await request("GET", "/api/swap/min"));
    ok("GET /api/swap/estimate?amountSol=0.1", await request("GET", "/api/swap/estimate?amountSol=0.1"));
    ok("GET /api/v1/clawstr/health", await request("GET", "/api/v1/clawstr/health"));
    ok("GET /api/v1/clawstr/feed?limit=5", await request("GET", "/api/v1/clawstr/feed?limit=5"));
    ok("GET /api/v1/clawstr/feed?limit=5&ai_only=1", await request("GET", "/api/v1/clawstr/feed?limit=5&ai_only=1"));
    ok("GET /api/v1/clawstr/communities", await request("GET", "/api/v1/clawstr/communities"));
    ok("GET /api/transactions/bitcoin", await request("GET", "/api/transactions/bitcoin"));
    ok("GET /api/transactions/solana", await request("GET", "/api/transactions/solana"));

    console.log("\n--- POST (no chain tx) ---");
    console.log("\n--- Error cases (no tx) ---");
    const invalidSwapEstimate = await request("GET", "/api/swap/estimate?amountSol=0");
    const expect400 = invalidSwapEstimate.status === 400;
    results.push({ name: "GET /api/swap/estimate invalid amount", pass: expect400, status: invalidSwapEstimate.status });
    console.log(expect400 ? "  OK" : "  FAIL", invalidSwapEstimate.status, "GET /api/swap/estimate invalid amount");
  } finally {
    child.kill("SIGTERM");
  }

  const fail = results.filter((r) => !r.pass);
  console.log("\n--- Summary ---");
  console.log(results.length - fail.length + "/" + results.length + " passed");
  if (fail.length) console.log("Failed:", fail.map((f) => f.name + " (" + f.status + ")").join(", "));
  process.exit(fail.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
