#!/usr/bin/env node
/**
 * Agent: swap 0.05 SOL → BTC via the droplet website API.
 * Server uses its reserve keys; BTC goes to reserve address (16yEBGKD1jBFE2eRUchDJcpLLP3wLoD1Mz when so configured).
 */
const BASE = "https://www.solanaagent.app";
const AMOUNT_SOL = 0.05;

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch (_) {
    d = t;
  }
  return { status: r.status, data: d };
}

async function main() {
  console.log("Agent: SOL → BTC swap, 0.05 SOL, via", BASE);
  const min = await req("GET", "/api/swap/min");
  if (min.status !== 200) {
    console.error("GET /api/swap/min failed:", min.status, min.data);
    process.exit(1);
  }
  console.log("Min SOL:", min.data.minAmountSol, "| Reserve balance:", min.data.balanceSol);

  const est = await req("GET", "/api/swap/estimate?amountSol=" + AMOUNT_SOL);
  if (est.status !== 200) {
    console.error("GET /api/swap/estimate failed:", est.status, est.data);
    process.exit(1);
  }
  console.log("Estimated BTC (sats):", est.data.estimatedBtcSats);

  console.log("\nPOST /api/swap/create ...");
  const create = await req("POST", "/api/swap/create", { amountSol: AMOUNT_SOL });
  if (create.status !== 200) {
    console.error("Create failed:", create.status, create.data);
    process.exit(1);
  }
  const id = create.data.id;
  console.log("Created. Solana tx (id):", id ? id.slice(0, 24) + "..." : id);
  console.log("Polling status (every 5s) ...");

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await req("GET", "/api/swap/status/" + encodeURIComponent(id));
    if (st.status !== 200) continue;
    const s = st.data.status;
    console.log("  [" + (i + 1) + "] status:", s);
    if (s === "finished" || s === "completed") {
      console.log("\nDone. BTC sats:", st.data.btcSats);
      process.exit(0);
    }
    if (s === "failed") {
      console.error("\nFailed:", st.data);
      process.exit(1);
    }
  }
  console.log("\nTimeout waiting for finished.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
