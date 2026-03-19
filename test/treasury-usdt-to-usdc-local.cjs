#!/usr/bin/env node
/**
 * Local tests for treasury USDT→USDC (no .env secrets required).
 *
 *   node test/treasury-usdt-to-usdc-local.cjs           # offline + mocked LI.FI
 *   node test/treasury-usdt-to-usdc-local.cjs --lifi    # optional: real LI.FI quote (network)
 */
const assert = require("assert");
const {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const {
  swapTreasuryUsdtToUsdc,
  fetchLifiUsdtToUsdcQuote,
  usdtToAtomic,
  USDT_MINT_MAINNET,
  USDC_MINT_MAINNET,
} = require("../lib/asry/treasury-usdt-to-usdc.cjs");

function test(name, fn) {
  try {
    fn();
    console.log("  ok:", name);
  } catch (e) {
    console.error("  FAIL:", name, e.message);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log("  ok:", name);
  } catch (e) {
    console.error("  FAIL:", name, e.message);
    process.exitCode = 1;
  }
}

async function main() {
  console.log("\n[treasury-usdt-to-usdc] unit tests\n");

  test("usdtToAtomic 1", () => assert.strictEqual(usdtToAtomic("1").toString(), "1000000"));
  test("usdtToAtomic 1.5", () => assert.strictEqual(usdtToAtomic("1.5").toString(), "1500000"));
  test("usdtToAtomic 0.000001", () =>
    assert.strictEqual(usdtToAtomic("0.000001").toString(), "1")
  );
  test("USDT mint", () => assert.ok(USDT_MINT_MAINNET.length > 30));
  test("USDC mint", () => assert.ok(USDC_MINT_MAINNET.length > 30));

  console.log("\n[treasury-usdt-to-usdc] validation\n");

  await testAsync("treasury/signer mismatch throws", async () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    let caught = false;
    try {
      await swapTreasuryUsdtToUsdc({
        treasuryAddress: a.publicKey.toBase58(),
        signerKeypair: b,
        amountUsdtAtomic: 1n,
        dryRun: true,
      });
    } catch (e) {
      caught = e.code === "TREASURY_SIGNER_MISMATCH";
    }
    assert.ok(caught, "expected TREASURY_SIGNER_MISMATCH");
  });

  await testAsync("missing treasury throws", async () => {
    const kp = Keypair.generate();
    let caught = false;
    try {
      await swapTreasuryUsdtToUsdc({
        treasuryAddress: "",
        signerKeypair: kp,
        amountUsdtAtomic: 1n,
      });
    } catch (e) {
      caught = e.code === "MISSING_TREASURY";
    }
    assert.ok(caught);
  });

  console.log("\n[treasury-usdt-to-usdc] mocked LI.FI + dryRun\n");

  await testAsync("swap dryRun with mock fetch", async () => {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0,
        }),
      ],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const mockData = Buffer.from(vtx.serialize()).toString("base64");

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        transactionRequest: { data: mockData },
        estimate: { toAmount: "999000" },
        tool: "mock-jupiter",
      }),
    });

    try {
      const out = await swapTreasuryUsdtToUsdc({
        treasuryAddress: addr,
        signerKeypair: kp,
        amountUsdtAtomic: 1000000n,
        dryRun: true,
      });
      assert.strictEqual(out.dryRun, true);
      assert.ok(out.signedTxBase64 && out.signedTxBase64.length > 50);
      assert.strictEqual(out.expectedUsdcAtomic, "999000");
      assert.strictEqual(out.signature, null);
    } finally {
      global.fetch = origFetch;
    }
  });

  if (process.argv.includes("--lifi")) {
    console.log("\n[treasury-usdt-to-usdc] LI.FI smoke (network)\n");
    try {
      const kp = Keypair.generate();
      const r = await fetchLifiUsdtToUsdcQuote({
        treasuryAddress: kp.publicKey.toBase58(),
        amountUsdtAtomic: 1_000_000n,
      });
      if (!r.ok) {
        console.log("  LI.FI HTTP:", r.status, r.quote?.message || "");
        console.log("  (Non-fatal for CI.)");
      } else if (r.hasTransaction) {
        console.log("  ok: LI.FI returned a Solana tx for 1 USDT quote");
      } else {
        console.log("  note: LI.FI ok but no tx in response");
      }
    } catch (e) {
      console.log("  LI.FI smoke skipped:", e.message);
    }
  }

  if (!process.exitCode) {
    console.log("\nAll treasury-usdt-to-usdc local tests passed.\n");
  }
}

main();
