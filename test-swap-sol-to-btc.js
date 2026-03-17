#!/usr/bin/env node
/**
 * Agent test: SOL → BTC swap via LI.FI using the website API.
 * Simulates an agent calling the live API to swap ~$5 of SOL; the server signs with
 * its SOLANA_PRIVATE_KEY and sends BTC to the reserve address (from BTC_PRIVATE_KEY_WIF).
 * No local signing; we only call the API. For a true "agent" test against local server,
 * set BASE to http://127.0.0.1:3001 and run the API with your .env (same keys = reserve = agent).
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const BASE = process.env.TEST_SWAP_BASE || "https://www.solanaagent.app";
const TARGET_USD = 5;

async function request(method, urlPath, body) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  console.log("Agent test: SOL → BTC swap (~$%d USD)", TARGET_USD);
  console.log("API base:", BASE);
  console.log("(Server uses its SOLANA_PRIVATE_KEY to send SOL; BTC goes to reserve address.)\n");

  const { status: sumStatus, data: summary } = await request("GET", "/api/arbitrage/summary");
  if (sumStatus !== 200 || !summary || summary.solPriceUsd == null) {
    console.error("Could not get SOL price from /api/arbitrage/summary. Status:", sumStatus);
    process.exit(1);
  }
  const solPriceUsd = Number(summary.solPriceUsd);
  const amountSol = TARGET_USD / solPriceUsd;
  console.log("SOL price (USD):", solPriceUsd);
  console.log("Amount SOL for $%d: %s", TARGET_USD, amountSol.toFixed(6));

  const { status: minStatus, data: minData } = await request("GET", "/api/swap/min");
  if (minStatus !== 200) {
    console.error("GET /api/swap/min failed:", minStatus, minData);
    process.exit(1);
  }
  const minSol = minData.minAmountSol != null ? Number(minData.minAmountSol) : null;
  const balanceSol = minData.balanceSol != null ? Number(minData.balanceSol) : null;
  console.log("Min SOL (swap):", minSol ?? "(not available)");
  console.log("Reserve SOL balance:", balanceSol);
  if (minSol != null && amountSol < minSol) {
    console.error("Amount SOL", amountSol, "is below minimum", minSol);
    process.exit(1);
  }
  if (balanceSol != null && amountSol > balanceSol) {
    console.error("Insufficient balance:", balanceSol, "SOL");
    process.exit(1);
  }
  if (balanceSol != null && balanceSol < 0.06) {
    console.warn("Warning: low SOL balance; swap may need fee reserve + rent buffer.");
  }

  const { status: estStatus, data: estData } = await request(
    "GET",
    "/api/swap/estimate?amountSol=" + encodeURIComponent(amountSol)
  );
  if (estStatus !== 200) {
    console.error("GET /api/swap/estimate failed:", estStatus, estData);
    process.exit(1);
  }
  console.log("Estimated BTC (sats):", estData.estimatedBtcSats);

  console.log("\n--- POST /api/swap/create ---");
  const { status: createStatus, data: createData } = await request("POST", "/api/swap/create", {
    amountSol,
  });
  if (createStatus !== 200) {
    console.error("POST /api/swap/create failed:", createStatus, createData);
    process.exit(1);
  }
  console.log("Swap created:");
  console.log("  id:", createData.id);
  console.log("  amountSol:", createData.amountSol);
  console.log("  expectedBtcSats:", createData.expectedBtcSats);
  console.log("  solanaSignature:", createData.solanaSignature || "(none)");
  console.log("  status:", createData.status);

  if (createData.id) {
    console.log("\nPolling status in 5s...");
    await new Promise((r) => setTimeout(r, 5000));
    const { status: stStatus, data: stData } = await request(
      "GET",
      "/api/swap/status/" + encodeURIComponent(createData.id)
    );
    if (stStatus === 200) {
      console.log("Status:", stData.status, "| btcSats:", stData.btcSats, "| payinAddress:", stData.payinAddress ? "(set)" : "");
    }
  }

  console.log("\nDone. BTC will be sent to the reserve Bitcoin address when LI.FI completes (can take minutes to hours).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
