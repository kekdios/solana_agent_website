/**
 * Single entry for treasury **receiving** stables:
 * - **USDT** → Jupiter swap **USDT → USDC** on the treasury wallet (normalize to USDC).
 * - **USDC** → **SPL token transfer only** (no Jupiter, no swap). Senders transfer USDC from
 *   their wallet to the treasury’s **USDC associated token account**. This path confirms balance
 *   or builds an unsigned transfer tx for the payer to sign.
 *
 * **SOLANA_PRIVATE_KEY** must control **TREASURY_SOLANA_ADDRESS** (used for USDT swap only).
 */
const { Connection, PublicKey, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const {
  swapTreasuryUsdtToUsdcJupiter,
  USDC_MINT_MAINNET,
  stableToAtomic,
  keypairFromEnvBase58,
} = require("./treasury-usdt-to-usdc-jupiter.cjs");

const USDC_DECIMALS = 6;

/** Where to send USDC: treasury wallet’s USDC ATA (plain SPL transfer, never Jupiter). */
async function getTreasuryUsdcDepositAta(treasuryAddress) {
  const treasury = new PublicKey((treasuryAddress || "").trim());
  const mint = new PublicKey(USDC_MINT_MAINNET);
  const ata = await getAssociatedTokenAddress(mint, treasury, false, TOKEN_PROGRAM_ID);
  return ata.toBase58();
}

/**
 * One SPL **TransferChecked** (USDC) from payer → treasury. Payer signs. No Jupiter.
 * @param {{ fromOwnerPubkey: string, treasuryAddress: string, amountAtomic: bigint|string|number, connection: Connection }} p
 */
async function buildUnsignedUsdcTransferToTreasury(p) {
  const mint = new PublicKey(USDC_MINT_MAINNET);
  const from = new PublicKey(p.fromOwnerPubkey.trim());
  const treasury = new PublicKey(p.treasuryAddress.trim());
  const amount = BigInt(String(p.amountAtomic));
  if (amount <= 0n) {
    const err = new Error("amountAtomic must be positive");
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  const sourceAta = await getAssociatedTokenAddress(mint, from, false, TOKEN_PROGRAM_ID);
  const destAta = await getAssociatedTokenAddress(mint, treasury, false, TOKEN_PROGRAM_ID);
  const ix = createTransferCheckedInstruction(
    sourceAta,
    mint,
    destAta,
    from,
    amount,
    USDC_DECIMALS,
    [],
    TOKEN_PROGRAM_ID
  );
  const { blockhash, lastValidBlockHeight } = await p.connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  return {
    transactionBase64: Buffer.from(vtx.serialize()).toString("base64"),
    treasuryUsdcAta: destAta.toBase58(),
    lastValidBlockHeight,
    viaJupiter: false,
    settlement: "spl_token_transfer_checked",
  };
}

async function getSplBalanceAtomic(connection, ownerPubkey, mintPubkey) {
  const accounts = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
    mint: mintPubkey,
  });
  let sum = 0n;
  for (const { account } of accounts.value) {
    sum += BigInt(account.data.parsed.info.tokenAmount.amount);
  }
  return sum;
}

/**
 * @param {object} opts
 * @param {'USDT'|'USDC'|string} opts.asset
 * @param {string|bigint|number} [opts.amount] human stable amount (6 dp), e.g. "0.5"
 * @param {bigint|string|number} [opts.amountAtomic] override atomic units
 * @param {string} opts.treasuryAddress
 * @param {import("@solana/web3.js").Keypair} opts.signerKeypair
 * @param {string} [opts.rpcUrl]
 * @param {boolean} [opts.dryRun] USDT only: quote+sign, no broadcast
 * @param {boolean} [opts.skipBalanceCheck] USDC only: do not require balance >= amount
 * @param {boolean} [opts.onlyDirectRoutes]
 */
async function receiveStableToTreasury(opts) {
  const asset = String(opts.asset || "")
    .trim()
    .toUpperCase();
  const treasury = (opts.treasuryAddress || "").trim();
  const rpcUrl =
    opts.rpcUrl ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const ownerPk = new PublicKey(treasury);

  const atomic =
    opts.amountAtomic != null
      ? BigInt(String(opts.amountAtomic))
      : stableToAtomic(String(opts.amount ?? "0"));
  if (atomic <= 0n) {
    const err = new Error("amount must be positive");
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  if (asset === "USDC") {
    const depositAta = await getTreasuryUsdcDepositAta(treasury);
    const bal = await getSplBalanceAtomic(
      conn,
      ownerPk,
      new PublicKey(USDC_MINT_MAINNET)
    );
    if (!opts.skipBalanceCheck && bal < atomic) {
      const err = new Error(
        `Treasury USDC balance ${bal} < expected ${atomic}. Deposit via SPL transfer to treasuryUsdcAta (not Jupiter).`
      );
      err.code = "INSUFFICIENT_USDC";
      err.usdcBalanceAtomic = bal.toString();
      err.treasuryUsdcAta = depositAta;
      throw err;
    }
    return {
      asset: "USDC",
      action: "usdc_spl_transfer",
      settlement: "spl_token_transfer_only",
      viaJupiter: false,
      routedToUsdc: true,
      treasuryAddress: treasury,
      treasuryUsdcAta: depositAta,
      usdcMint: USDC_MINT_MAINNET,
      requestedAtomic: atomic.toString(),
      usdcBalanceAtomic: bal.toString(),
      meetsRequested: bal >= atomic,
      onChainTxFromTreasury: null,
      message:
        "USDC: sender uses a normal SPL USDC transfer to treasuryUsdcAta (or ATA of TREASURY_SOLANA_ADDRESS). No swap, no Jupiter.",
    };
  }

  if (asset === "USDT") {
    const swap = await swapTreasuryUsdtToUsdcJupiter({
      treasuryAddress: treasury,
      signerKeypair: opts.signerKeypair,
      amountUsdtAtomic: atomic,
      dryRun: !!opts.dryRun,
      onlyDirectRoutes: opts.onlyDirectRoutes !== false,
      rpcUrl,
      skipPreflight: opts.skipPreflight,
    });
    return {
      asset: "USDT",
      action: "swapped_usdt_to_usdc",
      viaJupiter: true,
      settlement: "jupiter_swap",
      routedToUsdc: true,
      treasuryAddress: treasury,
      requestedAtomic: atomic.toString(),
      amountUsdtSwappedAtomic: swap.amountInAtomic,
      expectedUsdcOutAtomic: swap.expectedOutAtomic,
      swapSignature: swap.signature,
      dryRun: swap.dryRun,
      explorerUrl: swap.explorerUrl,
      signedTxBase64: swap.signedTxBase64 || null,
      routeLabel: swap.routeLabel,
      message:
        "Swapped USDT held at treasury to USDC via Jupiter (direct routes).",
    };
  }

  const err = new Error('asset must be "USDT" or "USDC"');
  err.code = "INVALID_ASSET";
  throw err;
}

module.exports = {
  receiveStableToTreasury,
  getTreasuryUsdcDepositAta,
  buildUnsignedUsdcTransferToTreasury,
  getSplBalanceAtomic,
  keypairFromEnvBase58,
  stableToAtomic,
  USDC_MINT_MAINNET,
};
