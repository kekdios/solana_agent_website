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
    ok("GET /api/transactions/bitcoin", await request("GET", "/api/transactions/bitcoin"));
    ok("GET /api/transactions/solana", await request("GET", "/api/transactions/solana"));
    ok("GET /api/arbitrage/transactions", await request("GET", "/api/arbitrage/transactions"));
    ok("GET /api/exchanges/transactions", await request("GET", "/api/exchanges/transactions"));
    ok("GET /api/tokens", await request("GET", "/api/tokens"));
    ok("GET /api/listings", await request("GET", "/api/listings"));
    ok("GET /api/listings/search", await request("GET", "/api/listings/search"));
    ok("GET /api/listings/search?q=x", await request("GET", "/api/listings/search?q=x"));

    console.log("\n--- POST (no chain tx) ---");
    const createRes = await request("POST", "/api/tokens", {
      name: "TestToken",
      symbol: "TST",
      decimals: 9,
      supply: "1000000000",
      description: "Test",
      revoke_freeze_authority: false,
      revoke_mint_authority: false,
      revoke_update_authority: false,
      metaplex_metadata: false,
    });
    const createOk = createRes.status === 200 || createRes.status === 503;
    results.push({ name: "POST /api/tokens (create)", pass: createOk, status: createRes.status });
    console.log(createOk ? "  OK" : "  FAIL", createRes.status, "POST /api/tokens (create)");
    if (createRes.status === 200) {
      const id = JSON.parse(createRes.data).id;
      if (id) ok("GET /api/tokens/" + id, await request("GET", "/api/tokens/" + id));
    }

    const listReqRes = await request("POST", "/api/listings/request", { token_id: 1 });
    const listReqOk = listReqRes.status === 200 || listReqRes.status === 400 || listReqRes.status === 404 || listReqRes.status === 503;
    results.push({ name: "POST /api/listings/request", pass: listReqOk, status: listReqRes.status });
    console.log(listReqOk ? "  OK" : "  FAIL", listReqRes.status, "POST /api/listings/request");

    console.log("\n--- Error cases (no tx) ---");
    const badConfirm = await request("POST", "/api/listings/confirm", {
      listing_request_id: "00000000-0000-0000-0000-000000000000",
      tx_signature: "fakesig",
    });
    const expectBad = badConfirm.status === 400 || badConfirm.status === 404 || badConfirm.status === 503;
    results.push({ name: "POST /api/listings/confirm (invalid)", pass: expectBad, status: badConfirm.status });
    console.log(expectBad ? "  OK" : "  FAIL", badConfirm.status, "POST /api/listings/confirm (invalid)");

    const noBody = await request("POST", "/api/tokens", {});
    const expect400 = noBody.status === 400;
    results.push({ name: "POST /api/tokens (no name/symbol)", pass: expect400, status: noBody.status });
    console.log(expect400 ? "  OK" : "  FAIL", noBody.status, "POST /api/tokens (no name/symbol)");
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
