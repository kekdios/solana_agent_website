/**
 * Treasury stable swaps via Jupiter (lite-api.jup.ag).
 * USDT→USDC and USDC→USDT (same direct-route + priority-fee behavior).
 */
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");

const USDT_MINT_MAINNET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STABLE_DECIMALS = 6;

const JUPITER_SWAP_BASE =
  (process.env.JUPITER_SWAP_API_URL || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");

const TREASURY_TEST_STABLECOIN_AMOUNT = "0.5";

async function swapTreasuryJupiter(opts) {
  const {
    treasuryAddress,
    signerKeypair,
    inputMint,
    outputMint,
    amountInAtomic,
    rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    slippageBps = Number(process.env.JUPITER_SLIPPAGE_BPS) || 50,
    onlyDirectRoutes = true,
    dryRun = false,
    skipPreflight = false,
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
      `TREASURY_SOLANA_ADDRESS must match SOLANA_PRIVATE_KEY pubkey (${signerPk}).`
    );
    err.code = "TREASURY_SIGNER_MISMATCH";
    throw err;
  }

  const fromAmount = BigInt(String(amountInAtomic));
  if (fromAmount <= 0n) {
    const err = new Error("amount must be positive");
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: fromAmount.toString(),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: onlyDirectRoutes ? "true" : "false",
  });

  const quoteRes = await fetch(`${JUPITER_SWAP_BASE}/quote?${quoteParams}`);
  const quote = await quoteRes.json().catch(() => null);
  if (!quoteRes.ok) {
    const err = new Error(
      (quote && (quote.error || quote.message)) || `Jupiter quote HTTP ${quoteRes.status}`
    );
    err.code = "JUPITER_QUOTE_FAILED";
    err.details = quote;
    throw err;
  }
  if (!quote || !quote.outAmount) {
    const err = new Error("Jupiter: no route (try onlyDirectRoutes=false or different amount)");
    err.code = "JUPITER_NO_ROUTE";
    err.details = quote;
    throw err;
  }

  const swapBody = buildJupiterSwapBody(treasury, quote);
  const swapRes = await fetch(`${JUPITER_SWAP_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  });
  const swapJson = await swapRes.json().catch(() => null);
  if (!swapRes.ok || !swapJson || !swapJson.swapTransaction) {
    const err = new Error(
      (swapJson && (swapJson.error || swapJson.message)) ||
        `Jupiter swap HTTP ${swapRes.status}`
    );
    err.code = "JUPITER_SWAP_FAILED";
    err.details = swapJson;
    throw err;
  }

  const txBuf = Buffer.from(swapJson.swapTransaction, "base64");
  const vtx = VersionedTransaction.deserialize(new Uint8Array(txBuf));
  vtx.sign([signerKeypair]);
  const signedTx = Buffer.from(vtx.serialize());
  const expectedOutAtomic = String(quote.outAmount);
  const routeLabel = quote.routePlan?.[0]?.swapInfo?.label || null;

  if (dryRun) {
    return {
      dryRun: true,
      signature: null,
      signedTxBase64: signedTx.toString("base64"),
      treasuryAddress: treasury,
      amountInAtomic: fromAmount.toString(),
      inputMint,
      outputMint,
      expectedOutAtomic,
      routeLabel,
      explorerUrl: null,
    };
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const signature = await connection.sendRawTransaction(signedTx, {
    skipPreflight,
    maxRetries: 3,
  });

  return {
    dryRun: false,
    signature,
    treasuryAddress: treasury,
    amountInAtomic: fromAmount.toString(),
    inputMint,
    outputMint,
    expectedOutAtomic,
    routeLabel,
    lastValidBlockHeight: swapJson.lastValidBlockHeight,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

function swapTreasuryUsdtToUsdcJupiter(opts) {
  return swapTreasuryJupiter({
    ...opts,
    inputMint: USDT_MINT_MAINNET,
    outputMint: USDC_MINT_MAINNET,
    amountInAtomic: opts.amountUsdtAtomic,
  });
}

function swapTreasuryUsdcToUsdtJupiter(opts) {
  return swapTreasuryJupiter({
    ...opts,
    inputMint: USDC_MINT_MAINNET,
    outputMint: USDT_MINT_MAINNET,
    amountInAtomic: opts.amountUsdcAtomic,
  });
}

function buildJupiterSwapBody(userPublicKey, quoteResponse) {
  const body = {
    userPublicKey,
    quoteResponse,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    useSharedAccounts: true,
  };
  const fixed = process.env.JUPITER_PRIORITY_LAMPORTS;
  if (fixed != null && fixed !== "" && !Number.isNaN(Number(fixed))) {
    body.prioritizationFeeLamports = Number(fixed);
  } else {
    const raw = (process.env.JUPITER_PRIORITY_LEVEL || "veryHigh").toLowerCase().replace(/_/g, "");
    const maxLamports = Number(process.env.JUPITER_PRIORITY_MAX_LAMPORTS) || 2_000_000;
    const levelMap = { medium: "medium", high: "high", veryhigh: "veryHigh" };
    const pl = levelMap[raw] || "veryHigh";
    body.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: { priorityLevel: pl, maxLamports: maxLamports },
    };
  }
  return body;
}

async function fetchJupiterUsdtToUsdcQuote(p) {
  return fetchJupiterPairQuote({
    ...p,
    inputMint: USDT_MINT_MAINNET,
    outputMint: USDC_MINT_MAINNET,
    amountAtomic: p.amountUsdtAtomic,
  });
}

async function fetchJupiterPairQuote(p) {
  const amount = BigInt(String(p.amountAtomic ?? p.amountUsdtAtomic));
  const params = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: amount.toString(),
    slippageBps: String(p.slippageBps ?? 50),
    onlyDirectRoutes: p.onlyDirectRoutes !== false ? "true" : "false",
  });
  const r = await fetch(`${JUPITER_SWAP_BASE}/quote?${params}`);
  const q = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, quote: q, outAmount: q?.outAmount };
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

function stableToAtomic(decimalString) {
  const s = String(decimalString).trim();
  const [whole, frac = ""] = s.split(".");
  const frac6 = (frac + "000000").slice(0, STABLE_DECIMALS);
  return BigInt(whole || "0") * 10n ** 6n + BigInt(frac6 || "0");
}

function usdtToAtomic(s) {
  return stableToAtomic(s);
}

module.exports = {
  swapTreasuryJupiter,
  swapTreasuryUsdtToUsdcJupiter,
  swapTreasuryUsdcToUsdtJupiter,
  fetchJupiterUsdtToUsdcQuote,
  fetchJupiterPairQuote,
  buildJupiterSwapBody,
  keypairFromEnvBase58,
  usdtToAtomic,
  stableToAtomic,
  USDT_MINT_MAINNET,
  USDC_MINT_MAINNET,
  TREASURY_TEST_STABLECOIN_AMOUNT,
  JUPITER_SWAP_BASE,
};
