#!/usr/bin/env node
/**
 * Smoke test: verify HTML pages have required structure, nav links, and assets.
 * Run from website/: node test-pages.js
 */
const fs = require("fs");
const path = require("path");

const PAGES = [
  "index.html",
  "treasury.html",
  "sabtc.html",
  "saeth.html",
  "asry.html",
  "reserves-bitcoin.html",
  "reserves-absr.html",
  "reserves-solana.html",
  "reserves-declaration.html",
  "proof-of-reserves.html",
  "api.html",
  "nostr.html",
  "visitors.html",
];

const REQUIRED_ASSETS = ["icon_dock.png", "solanaagent_rec.png", "pool-fee-format.js"];
const REQUIRED_NAV = ["index.html", "treasury.html", "sabtc.html", "saeth.html", "asry.html", "reserves-bitcoin.html", "reserves-absr.html", "reserves-solana.html", "reserves-declaration.html", "proof-of-reserves.html", "api.html"];

let failed = 0;

function check(name, cond) {
  if (!cond) {
    console.log("  FAIL:", name);
    failed++;
    return false;
  }
  console.log("  OK  ", name);
  return true;
}

for (const page of PAGES) {
  const filePath = path.join(__dirname, page);
  console.log("\n---", page, "---");
  if (!fs.existsSync(filePath)) {
    console.log("  FAIL: file not found");
    failed++;
    continue;
  }
  const html = fs.readFileSync(filePath, "utf8");

  check("has content", html.length > 500);
  check("has <title>", /<title>[^<]+<\/title>/.test(html));
  check("has viewport meta", /<meta[^>]+viewport/.test(html));
  check("has icon_dock.png", html.includes("icon_dock.png"));
  check("has solanaagent_rec.png", html.includes("solanaagent_rec.png"));

  const navCount = REQUIRED_NAV.filter((n) => html.includes(n)).length;
  check("nav links (at least 9 of 11)", navCount >= 9);

}

// Check assets exist
console.log("\n--- assets ---");
for (const asset of REQUIRED_ASSETS) {
  const p = path.join(__dirname, asset);
  check(asset + " exists", fs.existsSync(p));
}
const schedulePath = path.join(__dirname, "treasury-mint-schedule.json");
check("treasury-mint-schedule.json exists", fs.existsSync(schedulePath));
["loading-animation.gif", "logo_btc_nb.png"].forEach((asset) => {
  const p = path.join(__dirname, asset);
  if (fs.existsSync(p)) console.log("  OK  ", asset + " exists");
});

console.log("\n--- Summary ---");
if (failed) {
  console.log("FAILED:", failed, "checks");
  process.exit(1);
}
console.log("All page checks passed.");
process.exit(0);
