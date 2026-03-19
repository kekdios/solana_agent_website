/**
 * Swap treasury USDT → USDC on Solana via LI.FI (li.quest).
 * USDT must already be in the treasury wallet (associated token account).
 * Signing uses SOLANA_PRIVATE_KEY; TREASURY_SOLANA_ADDRESS must match that keypair's pubkey.
 *
 * @see https://docs.li.fi/
 */
const { Connection, Keypair, Transaction, VersionedTransaction, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

const LIFI_BASE = "https://li.quest/v1";

/** SPL Tether USD (Solana mainnet) */
const USDT_MINT_MAINNET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** SPL USDC (Solana mainnet) */
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDT_DECIMALS = 6;

/** Manual/integration tests: use **0.5** units of whichever stable is under test (USDT path vs USDC path). */
const TREASURY_TEST_STABLECOIN_AMOUNT = "0.5";

/**
 * @param {object} opts
 * @param {string} opts.treasuryAddress - Must equal pubkey of opts.signerKeypair
 * @param {import("@solana/web3.js").Keypair} opts.signerKeypair
 * @param {string} [opts.rpcUrl]
 * @param {bigint|number|string} opts.amountUsdtAtomic - USDT amount in smallest units (6 decimals)
 * @param {boolean} [opts.skipPreflight=true]
 * @param {boolean} [opts.dryRun=false] If true, sign but do not broadcast (local / CI safe).
 */
async function swapTreasuryUsdtToUsdc(opts) {
  const {
    treasuryAddress,
    signerKeypair,
    rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    amountUsdtAtomic,
    skipPreflight = true,
    dryRun = false,
  } = opts;

  const treasury = (treasuryAddress || "").trim();
  const signerPk = signerKeypair.publicKey.toBase58();
  if (!treasury) {
    const err = new Error("TREASURY_SOLANA_ADDRESS is required");
    err.code = "MISSING_TREASURY";
    throw err;
  }
  if (treasury !== signerPk) {
    const err = new Error(
      `TREASURY_SOLANA_ADDRESS (${treasury}) must match SOLANA_PRIVATE_KEY pubkey (${signerPk}). ` +
        "Only the treasury wallet can swap its own USDT balance."
    );
    err.code = "TREASURY_SIGNER_MISMATCH";
    throw err;
  }

  const fromAmount = BigInt(String(amountUsdtAtomic));
  if (fromAmount <= 0n) {
    const err = new Error("amountUsdtAtomic must be positive");
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  const quoteUrl =
    `${LIFI_BASE}/quote?fromChain=sol&toChain=sol` +
    `&fromToken=${USDT_MINT_MAINNET}&toToken=${USDC_MINT_MAINNET}` +
    `&fromAmount=${fromAmount.toString()}` +
    `&fromAddress=${encodeURIComponent(treasury)}` +
    `&toAddress=${encodeURIComponent(treasury)}`;

  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json().catch(() => null);
  if (!quoteRes.ok) {
    const msg =
      (quote && (quote.message || quote.errorMessage)) ||
      `LI.FI quote HTTP ${quoteRes.status}`;
    const err = new Error(msg);
    err.code = "LIFI_QUOTE_FAILED";
    err.details = quote;
    throw err;
  }
  if (!quote || !quote.transactionRequest || !quote.transactionRequest.data) {
    const err = new Error("LI.FI: no transaction in quote (try smaller amount or check USDT balance)");
    err.code = "LIFI_NO_TX";
    err.details = quote;
    throw err;
  }

  const estimate = quote.estimate || {};
  const expectedUsdcAtomic =
    estimate.toAmount != null ? String(estimate.toAmount) : null;

  const txBuffer = Buffer.from(quote.transactionRequest.data, "base64");
  if (!txBuffer.length) {
    const err = new Error("LI.FI: empty transaction");
    err.code = "LIFI_EMPTY_TX";
    throw err;
  }

  const u8 = new Uint8Array(txBuffer);
  let signedTxBuffer;
  try {
    const versionedTx = VersionedTransaction.deserialize(u8);
    versionedTx.sign([signerKeypair]);
    signedTxBuffer = Buffer.from(versionedTx.serialize());
  } catch (_) {
    try {
      const legacyTx = Transaction.from(txBuffer);
      legacyTx.sign(signerKeypair);
      signedTxBuffer = Buffer.from(legacyTx.serialize());
    } catch (e) {
      const err = new Error("Failed to sign swap tx: " + (e.message || String(e)));
      err.code = "SIGN_FAILED";
      throw err;
    }
  }

  if (dryRun) {
    return {
      dryRun: true,
      signature: null,
      signedTxBase64: signedTxBuffer.toString("base64"),
      treasuryAddress: treasury,
      amountUsdtAtomic: fromAmount.toString(),
      expectedUsdcAtomic,
      tool: quote.tool || null,
      explorerUrl: null,
    };
  }

  const connection = new Connection(rpcUrl, "confirmed");
  let signature;
  try {
    signature = await connection.sendRawTransaction(signedTxBuffer, { skipPreflight });
  } catch (e) {
    const err = new Error("Solana send failed: " + (e.message || String(e)));
    err.code = "SEND_FAILED";
    throw err;
  }

  return {
    dryRun: false,
    signature,
    treasuryAddress: treasury,
    amountUsdtAtomic: fromAmount.toString(),
    expectedUsdcAtomic,
    tool: quote.tool || null,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

/**
 * LI.FI quote only (no signing). Useful for smoke tests.
 * @param {{ treasuryAddress: string, amountUsdtAtomic: bigint|string|number }} p
 */
async function fetchLifiUsdtToUsdcQuote(p) {
  const treasury = (p.treasuryAddress || "").trim();
  const fromAmount = BigInt(String(p.amountUsdtAtomic));
  const quoteUrl =
    `${LIFI_BASE}/quote?fromChain=sol&toChain=sol` +
    `&fromToken=${USDT_MINT_MAINNET}&toToken=${USDC_MINT_MAINNET}` +
    `&fromAmount=${fromAmount.toString()}` +
    `&fromAddress=${encodeURIComponent(treasury)}` +
    `&toAddress=${encodeURIComponent(treasury)}`;
  const quoteRes = await fetch(quoteUrl);
  const quote = await quoteRes.json().catch(() => null);
  return {
    ok: quoteRes.ok,
    status: quoteRes.status,
    quote,
    hasTransaction: !!(quote && quote.transactionRequest && quote.transactionRequest.data),
  };
}

function keypairFromEnvBase58(privateKeyBase58) {
  const b58 = (privateKeyBase58 || "").trim();
  if (!b58) return null;
  try {
    const decode = bs58.default ? bs58.default.decode : bs58.decode;
    return Keypair.fromSecretKey(decode(b58));
  } catch (_) {
    return null;
  }
}

/** Human USDT (e.g. 12.5) → atomic string */
function usdtToAtomic(decimalString) {
  const s = String(decimalString).trim();
  const neg = s.startsWith("-");
  const t = neg ? s.slice(1) : s;
  const [whole, frac = ""] = t.split(".");
  const frac6 = (frac + "000000").slice(0, USDT_DECIMALS);
  const w = BigInt(whole || "0");
  const f = BigInt(frac6 || "0");
  let n = w * 10n ** BigInt(USDT_DECIMALS) + f;
  if (neg) n = -n;
  return n;
}

module.exports = {
  swapTreasuryUsdtToUsdc,
  fetchLifiUsdtToUsdcQuote,
  keypairFromEnvBase58,
  usdtToAtomic,
  USDT_MINT_MAINNET,
  USDC_MINT_MAINNET,
  USDT_DECIMALS,
  LIFI_BASE,
  TREASURY_TEST_STABLECOIN_AMOUNT,
};
