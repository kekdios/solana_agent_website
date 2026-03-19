/**
 * After a successful stable receive (USDT swap or USDC deposit tx), send the sender
 * a fixed USD-notional of ASRY (default $0.50 at $100/ASRY via asry-price).
 */
const {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const {
  swapTreasuryUsdtToUsdcJupiter,
  USDC_MINT_MAINNET,
  stableToAtomic,
} = require("./treasury-usdt-to-usdc-jupiter.cjs");
const { getAsryPriceUsd, usdToAsryAtomic, ASRY_MINT_TREASURY_MAINNET } = require("./asry-price.cjs");

const DEFAULT_REWARD_USD = 0.5;
/** Fee rate: 0.05% of each receive (5 bps). */
const RECEIVE_FEE_BPS = 5;
const CONFIRM_POLL_MS = 2000;
const CONFIRM_TIMEOUT_MS = 120000;

async function waitForSignatureStatus(conn, signature, timeoutMs = CONFIRM_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = value[0];
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      if (s.err) return { ok: false, err: s.err, status: "failed_on_chain" };
      return { ok: true, status: s.confirmationStatus };
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
  return { ok: false, err: "confirmation_timeout", status: "timeout" };
}

/** Net USDC credited to treasury in this tx (mint + owner = treasury wallet). */
function usdcCreditToTreasury(meta, treasuryBase58, minAtomic) {
  const mint = USDC_MINT_MAINNET;
  const pre = meta?.preTokenBalances || [];
  const post = meta?.postTokenBalances || [];
  const preAmt = balanceForOwnerMint(pre, treasuryBase58, mint);
  const postAmt = balanceForOwnerMint(post, treasuryBase58, mint);
  const delta = postAmt - preAmt;
  return { delta, ok: delta >= BigInt(minAtomic) };
}

function balanceForOwnerMint(balances, owner, mint) {
  let sum = 0n;
  for (const b of balances) {
    if (b.mint === mint && b.owner === owner) {
      sum += BigInt(b.uiTokenAmount?.amount ?? "0");
    }
  }
  return sum;
}

async function verifyUsdcDepositTx(conn, signature, treasuryAddress, minAtomic) {
  const tx = await conn.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) return { ok: false, reason: "tx_not_found" };
  if (tx.meta?.err) return { ok: false, reason: "tx_failed", err: tx.meta.err };
  const { delta, ok } = usdcCreditToTreasury(tx.meta, treasuryAddress.trim(), minAtomic);
  if (!ok) return { ok: false, reason: "insufficient_usdc_credit", creditedAtomic: delta.toString() };
  return { ok: true, creditedAtomic: delta.toString() };
}

/**
 * Treasury sends ASRY reward to recipient. Creates recipient ATA if missing (treasury pays rent).
 */
async function sendAsryRewardToSender(opts) {
  const {
    connection,
    treasuryKeypair,
    recipientPubkey,
    asryMint,
    asryDecimals = 9,
    amountAtomic,
  } = opts;

  const treasury = treasuryKeypair.publicKey;
  const recipient = new PublicKey(recipientPubkey.trim());
  const mint = new PublicKey(String(asryMint).trim());

  const sourceAta = await getAssociatedTokenAddress(mint, treasury, false, TOKEN_PROGRAM_ID);
  const destAta = await getAssociatedTokenAddress(mint, recipient, false, TOKEN_PROGRAM_ID);

  const srcInfo = await connection.getAccountInfo(sourceAta);
  if (!srcInfo) {
    const err = new Error("Treasury has no ASRY token account; fund treasury ASRY ATA");
    err.code = "TREASURY_NO_ASRY_ATA";
    throw err;
  }

  const ixs = [];
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        treasury,
        destAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID
      )
    );
  }

  const amt = BigInt(String(amountAtomic));
  if (amt <= 0n) {
    const err = new Error("ASRY reward amount must be positive");
    err.code = "INVALID_REWARD_AMOUNT";
    throw err;
  }

  ixs.push(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destAta,
      treasury,
      amt,
      asryDecimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: treasury,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([treasuryKeypair]);
  const raw = vtx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * @param {object} opts
 * @param {'USDT'|'USDC'} opts.asset
 * @param {string} [opts.amount] human 6dp stable amount
 * @param {string} opts.senderPubkey - receives ASRY reward
 * @param {string} opts.treasuryAddress
 * @param {import("@solana/web3.js").Keypair} opts.signerKeypair
 * @param {string} [opts.depositTxSignature] - **USDC required**: tx where user sent USDC to treasury
 * @param {number} [opts.rewardUsd=0.5]
 * @param {boolean} [opts.skipReward]
 * @param {string} [opts.asryMint] - defaults env ASRY_MINT_ADDRESS
 * @param {number} [opts.asryDecimals] - defaults env ASRY_DECIMALS or 9
 */
async function receiveStableConfirmAndReward(opts) {
  const asset = String(opts.asset || "")
    .trim()
    .toUpperCase();
  const treasury = (opts.treasuryAddress || "").trim();
  const sender = (opts.senderPubkey || "").trim();
  const rpcUrl =
    opts.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const rewardUsd =
    opts.rewardUsd != null
      ? Number(opts.rewardUsd)
      : Number(process.env.ASRY_REWARD_USD) || DEFAULT_REWARD_USD;
  const skipReward = !!opts.skipReward;
  const asryMint = (
    opts.asryMint ||
    process.env.ASRY_MINT_ADDRESS ||
    ASRY_MINT_TREASURY_MAINNET ||
    ""
  ).trim();
  const asryDecimals = Number(opts.asryDecimals ?? process.env.ASRY_DECIMALS) || 9;

  if (!treasury || opts.signerKeypair.publicKey.toBase58() !== treasury) {
    const err = new Error("treasuryAddress must match signerKeypair");
    err.code = "TREASURY_SIGNER_MISMATCH";
    throw err;
  }
  if (!sender) {
    const err = new Error("senderPubkey required (ASRY reward destination)");
    err.code = "MISSING_SENDER";
    throw err;
  }

  const atomic =
    opts.amountAtomic != null
      ? BigInt(String(opts.amountAtomic))
      : stableToAtomic(String(opts.amount ?? "0"));
  if (atomic <= 0n) {
    const err = new Error("amount must be positive");
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  const priceInfo = getAsryPriceUsd();
  const rewardAsryAtomic = skipReward ? 0n : usdToAsryAtomic(rewardUsd, asryDecimals);
  /** 0.05% fee held back from each receive (for accounting / future distribution). */
  const feeAtomic = (atomic * BigInt(RECEIVE_FEE_BPS)) / 10000n;

  const out = {
    asset,
    senderPubkey: sender,
    treasuryAddress: treasury,
    rewardUsd,
    asryPrice: priceInfo,
    rewardAsryAtomic: rewardAsryAtomic.toString(),
    receive: null,
    reward: null,
    /** Fee held back: 0.05% of receive amount (smallest units). */
    feeBps: RECEIVE_FEE_BPS,
    feeAtomic: feeAtomic.toString(),
  };

  if (asset === "USDT") {
    const swap = await swapTreasuryUsdtToUsdcJupiter({
      treasuryAddress: treasury,
      signerKeypair: opts.signerKeypair,
      amountUsdtAtomic: atomic,
      dryRun: !!opts.dryRun,
      onlyDirectRoutes: opts.onlyDirectRoutes !== false,
      rpcUrl,
    });
    if (opts.dryRun) {
      out.receive = { ...swap, confirmed: false, dryRun: true };
      out.reward = skipReward ? { skipped: true } : { previewAtomic: rewardAsryAtomic.toString() };
      return out;
    }
    const sig = swap.signature;
    if (!sig) {
      const err = new Error("USDT swap did not return signature");
      err.code = "SWAP_NO_SIG";
      throw err;
    }
    const conf = await waitForSignatureStatus(conn, sig);
    out.receive = {
      swapSignature: sig,
      explorerUrl: swap.explorerUrl,
      confirmation: conf,
      feeAtomic: feeAtomic.toString(),
    };
    if (!conf.ok) {
      out.reward = { skipped: true, reason: "receive_not_confirmed" };
      return out;
    }
  } else if (asset === "USDC") {
    const depSig = (opts.depositTxSignature || "").trim();
    if (!depSig) {
      const err = new Error("USDC path requires depositTxSignature (payer’s USDC transfer tx to treasury)");
      err.code = "MISSING_DEPOSIT_TX";
      throw err;
    }
    const conf = await waitForSignatureStatus(conn, depSig);
    if (!conf.ok) {
      out.receive = { depositTxSignature: depSig, confirmation: conf };
      out.reward = { skipped: true, reason: "deposit_not_confirmed" };
      return out;
    }
    const ver = await verifyUsdcDepositTx(conn, depSig, treasury, atomic);
    out.receive = { depositTxSignature: depSig, verification: ver, feeAtomic: feeAtomic.toString() };
    if (!ver.ok) {
      out.reward = { skipped: true, reason: ver.reason, creditedAtomic: ver.creditedAtomic };
      return out;
    }
  } else {
    const err = new Error('asset must be USDT or USDC');
    err.code = "INVALID_ASSET";
    throw err;
  }

  if (skipReward || rewardAsryAtomic === 0n) {
    out.reward = { skipped: true };
    return out;
  }
  if (!asryMint) {
    const err = new Error("Set ASRY_MINT_ADDRESS for ASRY rewards");
    err.code = "MISSING_ASRY_MINT";
    throw err;
  }

  try {
    const rewardSig = await sendAsryRewardToSender({
      connection: conn,
      treasuryKeypair: opts.signerKeypair,
      recipientPubkey: sender,
      asryMint,
      asryDecimals,
      amountAtomic: rewardAsryAtomic,
    });
    out.reward = {
      signature: rewardSig,
      explorerUrl: `https://solscan.io/tx/${rewardSig}`,
      asryAtomic: rewardAsryAtomic.toString(),
    };
  } catch (e) {
    const hint =
      /insufficient funds/i.test(e.message)
        ? " (Fund the treasury's ASRY ATA for this mint with at least the reward amount)"
        : "";
    out.reward = { failed: true, error: e.message + hint, code: e.code };
    throw Object.assign(e, { partialResult: out });
  }

  return out;
}

module.exports = {
  receiveStableConfirmAndReward,
  waitForSignatureStatus,
  verifyUsdcDepositTx,
  sendAsryRewardToSender,
  usdToAsryAtomic,
  getAsryPriceUsd,
  DEFAULT_REWARD_USD,
};
