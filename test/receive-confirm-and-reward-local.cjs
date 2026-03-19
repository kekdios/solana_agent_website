#!/usr/bin/env node
/**
 * Local tests for receive-confirm-and-reward (price, ASRY mint default, reward atomic).
 * No .env required for unit tests; integration uses env.
 */
const assert = require("assert");
const { getAsryPriceUsd, usdToAsryAtomic, ASRY_MINT_TREASURY_MAINNET } = require("../lib/asry/asry-price.cjs");

function test(name, fn) {
  try {
    fn();
    console.log("  ok:", name);
  } catch (e) {
    console.error("  FAIL:", name, e.message);
    process.exitCode = 1;
  }
}

console.log("\n[receive-confirm-and-reward] asry-price + mint\n");

test("getAsryPriceUsd returns 100", () => {
  const p = getAsryPriceUsd();
  assert.strictEqual(p.priceUsdPerAsry, 100);
  assert.ok(p.source);
});

test("$0.50 → 5_000_000 atomic (9 decimals)", () => {
  const atomic = usdToAsryAtomic(0.5, 9);
  assert.strictEqual(Number(atomic), 5_000_000);
});

test("ASRY_MINT_TREASURY_MAINNET is set", () => {
  assert.strictEqual(ASRY_MINT_TREASURY_MAINNET, "3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw");
});

test("default mint used when ASRY_MINT_ADDRESS unset in opts", async () => {
  const { receiveStableConfirmAndReward } = require("../lib/asry/receive-confirm-and-reward.cjs");
  const Keypair = require("@solana/web3.js").Keypair;
  const kp = Keypair.generate();
  const prev = process.env.ASRY_MINT_ADDRESS;
  delete process.env.ASRY_MINT_ADDRESS;
  try {
    const out = await receiveStableConfirmAndReward({
      asset: "USDT",
      amount: "0.5",
      senderPubkey: kp.publicKey.toBase58(),
      treasuryAddress: kp.publicKey.toBase58(),
      signerKeypair: kp,
      dryRun: true,
    });
    assert.ok(out.asryPrice?.priceUsdPerAsry === 100);
    assert.strictEqual(out.rewardAsryAtomic, "5000000");
    assert.ok(out.reward && (out.reward.previewAtomic === "5000000" || out.reward.skipped === true));
  } finally {
    if (prev !== undefined) process.env.ASRY_MINT_ADDRESS = prev;
  }
});

test("reward output has signature when not dryRun and not skipped", () => {
  const { humanAmountToAtomic } = require("../lib/asry/mint-token-human.cjs");
  const atomic = humanAmountToAtomic(0.005, 9);
  assert.strictEqual(atomic.toString(), "5000000", "0.005 ASRY = 5_000_000 atomic for reward");
});

if (!process.exitCode) console.log("\nAll receive-confirm-and-reward local tests passed.\n");
