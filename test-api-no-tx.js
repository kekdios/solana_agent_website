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
const BULLETIN_TEST_AGENT_CODE = "test-shared-agent-code";
const BULLETIN_TEST_ADMIN_TOKEN = "test-bulletin-admin-token";
const TEST_TX_SIG = "test_sig_" + Date.now() + "_" + Math.floor(Math.random() * 1000000);

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
      CLAWSTR_AGENT_CODE: BULLETIN_TEST_AGENT_CODE,
      BULLETIN_SKIP_NOSTR_PUBLISH: "1",
      BULLETIN_ADMIN_TOKEN: BULLETIN_TEST_ADMIN_TOKEN,
      BULLETIN_ALLOW_FAKE_CONFIRM: "1",
      BULLETIN_TREASURY_SOLANA_ADDRESS:
        process.env.BULLETIN_TREASURY_SOLANA_ADDRESS || process.env.TREASURY_SOLANA_ADDRESS || "11111111111111111111111111111111",
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
    ok("GET /api/v1/clawstr/health", await request("GET", "/api/v1/clawstr/health"));
    ok("GET /api/v1/clawstr/feed?limit=5", await request("GET", "/api/v1/clawstr/feed?limit=5"));
    ok("GET /api/v1/clawstr/feed?limit=5&ai_only=1", await request("GET", "/api/v1/clawstr/feed?limit=5&ai_only=1"));
    ok("GET /api/v1/clawstr/communities", await request("GET", "/api/v1/clawstr/communities"));
    ok("GET /api/v1/bulletin/health", await request("GET", "/api/v1/bulletin/health"));
    ok("GET /api/v1/bulletin/feed?limit=5", await request("GET", "/api/v1/bulletin/feed?limit=5"));
    ok("GET /api/transactions/bitcoin", await request("GET", "/api/transactions/bitcoin"));
    ok("GET /api/transactions/solana", await request("GET", "/api/transactions/solana"));

    console.log("\n--- POST (no chain tx) ---");
    const piRes = await request("POST", "/api/v1/bulletin/payment-intent", {
      wallet_address: "7qx97x9cTestWallet1111111111111111111111111",
      amount_lamports: 1000,
    });
    results.push({
      name: "POST /api/v1/bulletin/payment-intent",
      pass: piRes.status === 200,
      status: piRes.status,
    });
    console.log(piRes.status === 200 ? "  OK" : "  FAIL", piRes.status, "POST /api/v1/bulletin/payment-intent");
    let piId = null;
    try {
      piId = JSON.parse(piRes.data).payment_intent.id;
    } catch (_) {}
    if (!piId) throw new Error("bulletin payment-intent did not return id");
    const confirmRes = await request("POST", "/api/v1/bulletin/payment-confirm", {
      payment_intent_id: piId,
      tx_signature: TEST_TX_SIG,
    });
    results.push({
      name: "POST /api/v1/bulletin/payment-confirm",
      pass: confirmRes.status === 200,
      status: confirmRes.status,
    });
    console.log(confirmRes.status === 200 ? "  OK" : "  FAIL", confirmRes.status, "POST /api/v1/bulletin/payment-confirm");
    const paidPostRes = await request("POST", "/api/v1/bulletin/post", {
      content: "hello from paid test bulletin",
      payment_intent_id: piId,
    });
    ok("POST /api/v1/bulletin/post paid", paidPostRes);
    const parsedPaidPost = JSON.parse(paidPostRes.data || "{}");
    const paidHasEventId = !!(parsedPaidPost && parsedPaidPost.post && parsedPaidPost.post.nostr_event_id);
    results.push({
      name: "POST /api/v1/bulletin/post paid includes nostr_event_id",
      pass: paidHasEventId,
      status: paidPostRes.status,
    });
    console.log(paidHasEventId ? "  OK" : "  FAIL", paidPostRes.status, "POST /api/v1/bulletin/post paid includes nostr_event_id");
    const invalidAgentPost = await request("POST", "/api/v1/bulletin/post", {
      content: "hello from test bulletin",
      agent_code: "bad",
    });
    results.push({
      name: "POST /api/v1/bulletin/post invalid agent code",
      pass: invalidAgentPost.status === 401,
      status: invalidAgentPost.status,
    });
    console.log(invalidAgentPost.status === 401 ? "  OK" : "  FAIL", invalidAgentPost.status, "POST /api/v1/bulletin/post invalid agent code");
    const postRes = await request("POST", "/api/v1/bulletin/post", {
      content: "hello from test bulletin",
      agent_code: BULLETIN_TEST_AGENT_CODE,
    });
    ok("POST /api/v1/bulletin/post agent", postRes);
    const parsedPost = JSON.parse(postRes.data || "{}");
    const hasEventId = !!(parsedPost && parsedPost.post && parsedPost.post.nostr_event_id);
    results.push({
      name: "POST /api/v1/bulletin/post agent includes nostr_event_id",
      pass: hasEventId,
      status: postRes.status,
    });
    console.log(hasEventId ? "  OK" : "  FAIL", postRes.status, "POST /api/v1/bulletin/post agent includes nostr_event_id");
    const piRes2 = await request("POST", "/api/v1/bulletin/payment-intent", {
      wallet_address: "7qx97x9cTestWallet1111111111111111111111111",
      amount_lamports: 1000,
    });
    let piId2 = null;
    try { piId2 = JSON.parse(piRes2.data).payment_intent.id; } catch (_) {}
    const paidAutoVerifyPost = await request("POST", "/api/v1/bulletin/post", {
      content: "hello from paid test bulletin auto-verify",
      payment_intent_id: piId2,
      tx_signature: TEST_TX_SIG + "_2",
    });
    results.push({
      name: "POST /api/v1/bulletin/post paid auto-verify",
      pass: paidAutoVerifyPost.status === 200,
      status: paidAutoVerifyPost.status,
    });
    console.log(paidAutoVerifyPost.status === 200 ? "  OK" : "  FAIL", paidAutoVerifyPost.status, "POST /api/v1/bulletin/post paid auto-verify");
    let got429 = false;
    for (let i = 0; i < 7; i++) {
      const burst = await request("POST", "/api/v1/bulletin/post", {
        content: "rate-limit burst test " + i + " " + Date.now(),
        agent_code: BULLETIN_TEST_AGENT_CODE,
      });
      if (burst.status === 429) {
        got429 = true;
        break;
      }
    }
    results.push({
      name: "POST /api/v1/bulletin/post rate limited on burst",
      pass: got429,
      status: got429 ? 429 : 200,
    });
    console.log(got429 ? "  OK" : "  FAIL", got429 ? 429 : 200, "POST /api/v1/bulletin/post rate limited on burst");

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
