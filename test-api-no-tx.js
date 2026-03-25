#!/usr/bin/env node
/**
 * Test API endpoints without doing any real transaction.
 * Run from website/: node test-api-no-tx.js
 */
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 3100 + Math.floor(Math.random() * 500);
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
    env: {
      ...process.env,
      API_PORT: String(PORT),
    },
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
    ok("GET /api/nostr/feed?limit=5&ai_only=true", await request("GET", "/api/nostr/feed?limit=5&ai_only=true"));
    ok("GET /api/nostr/posts?limit=1", await request("GET", "/api/nostr/posts?limit=1"));
    ok("GET /api/analytics/stats", await request("GET", "/api/analytics/stats"));
    const pvPost = await request("POST", "/api/analytics/pageview", {
      path: "/test-pageview-" + Date.now(),
      referrer: "",
    });
    results.push({
      name: "POST /api/analytics/pageview",
      pass: pvPost.status === 204,
      status: pvPost.status,
    });
    console.log(pvPost.status === 204 ? "  OK" : "  FAIL", pvPost.status, "POST /api/analytics/pageview");
    const statsAfterPv = await request("GET", "/api/analytics/stats");
    let statsJ = {};
    try {
      statsJ = JSON.parse(statsAfterPv.data || "{}");
    } catch (_) {}
    const statsHasViews =
      statsAfterPv.status === 200 && statsJ.ok === true && Number(statsJ.total_pageviews) >= 1;
    results.push({
      name: "GET /api/analytics/stats after pageview",
      pass: statsHasViews,
      status: statsAfterPv.status,
    });
    console.log(statsHasViews ? "  OK" : "  FAIL", statsAfterPv.status, "GET /api/analytics/stats after pageview");
    ok("GET /api/transactions/bitcoin", await request("GET", "/api/transactions/bitcoin"));
    ok("GET /api/transactions/solana", await request("GET", "/api/transactions/solana"));

    {
      const r = await request("GET", "/api/orca/pool/7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm");
      let j = {};
      try {
        j = JSON.parse(r.data || "{}");
      } catch (_) {}
      const pass = r.status === 200 && j.data && j.data.address;
      results.push({ name: "GET /api/orca/pool (Orca Whirlpool)", pass, status: r.status });
      console.log(pass ? "  OK" : "  FAIL", r.status, "GET /api/orca/pool (Orca Whirlpool)");
    }
    {
      const r = await request("GET", "/api/orca/pool/short");
      const pass = r.status === 400;
      results.push({ name: "GET /api/orca/pool invalid id 400", pass, status: r.status });
      console.log(pass ? "  OK" : "  FAIL", r.status, "GET /api/orca/pool invalid id 400");
    }
    {
      const r = await request("GET", "/api/orca/pool-saeth-sausd-default");
      const pass = r.status === 307;
      results.push({ name: "GET /api/orca/pool-saeth-sausd-default 307", pass, status: r.status });
      console.log(pass ? "  OK" : "  FAIL", r.status, "GET /api/orca/pool-saeth-sausd-default 307");
    }
    {
      const poolId = "BzwjX8hwMbkVdhGu2w9qTtokr5ExqSDSw9bNMxdkExRS";
      const r = await request("GET", "/api/orca/pool/" + poolId);
      let j = {};
      try {
        j = JSON.parse(r.data || "{}");
      } catch (_) {}
      const d = j.data || {};
      const fromRpc =
        d.poolDataSource === "solana_rpc" &&
        typeof d.swapFeePercentDisplay === "string" &&
        d.swapFeePercentDisplay.includes("%");
      const fromOrcaIndexer =
        d.tokenMintA &&
        (d.tokenBalanceA != null || (d.tokenA && d.tokenA.address));
      const pass = r.status === 200 && d.address === poolId && fromOrcaIndexer && (fromRpc || d.feeRate != null || d.stats);
      results.push({ name: "GET /api/orca/pool SAETH/SAUSD default pool", pass, status: r.status });
      console.log(pass ? "  OK" : "  FAIL", r.status, "GET /api/orca/pool SAETH/SAUSD default pool");
    }
    {
      const poolId = "B7rRNh2ur5K7xvFp8V3L5wJ6qKxnfNeKSq76Bz3EfLdK";
      const r = await request("GET", "/api/orca/pool/" + poolId);
      let j = {};
      try {
        j = JSON.parse(r.data || "{}");
      } catch (_) {}
      const d = j.data || {};
      const balA = d.tokenBalanceA != null ? String(d.tokenBalanceA) : "";
      const balB = d.tokenBalanceB != null ? String(d.tokenBalanceB) : "";
      const pass =
        r.status === 200 &&
        d.tokenVaultA &&
        balA !== "" &&
        balA !== "0" &&
        balB !== "" &&
        balB !== "0";
      results.push({
        name: "GET /api/orca/pool SAUSD/USDC vault balances filled from RPC when Orca shows 0",
        pass,
        status: r.status,
      });
      console.log(
        pass ? "  OK" : "  FAIL",
        r.status,
        "GET /api/orca/pool SAUSD/USDC vault balances filled from RPC when Orca shows 0"
      );
    }

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
