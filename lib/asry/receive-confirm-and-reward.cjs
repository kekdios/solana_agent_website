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
  USDT_MINT_MAINNET,
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

function flattenParsedInstructions(tx) {
  const out = [];
  const top = tx?.transaction?.message?.instructions || [];
  for (const ix of top) out.push(ix);
  const innerGroups = tx?.meta?.innerInstructions || [];
  for (const g of innerGroups) {
    for (const ix of g.instructions || []) out.push(ix);
  }
  return out;
}

function parseTransferAtomic(ix) {
  const info = ix?.parsed?.info || {};
  if (ix?.parsed?.type === "transferChecked") {
    const amt = info.tokenAmount?.amount;
    if (amt != null) return BigInt(String(amt));
  }
  if (ix?.parsed?.type === "transfer") {
    const amt = info.amount;
    if (amt != null) return BigInt(String(amt));
  }
  return null;
}

async function inferSenderFromStableDepositTx(conn, tx, treasuryAddress, mintBase58) {
  const treasuryPk = new PublicKey(String(treasuryAddress).trim());
  const mintPk = new PublicKey(String(mintBase58).trim());
  const treasuryAta = (
    await getAssociatedTokenAddress(mintPk, treasuryPk, true, TOKEN_PROGRAM_ID)
  ).toBase58();
  const candidates = [];
  const ixs = flattenParsedInstructions(tx);
  for (const ix of ixs) {
    if (ix?.program !== "spl-token") continue;
    const t = ix?.parsed?.type;
    if (t !== "transfer" && t !== "transferChecked") continue;
    const info = ix?.parsed?.info || {};
    if ((info.destination || "") !== treasuryAta) continue;
    const sourceAta = (info.source || "").trim();
    if (!sourceAta) continue;
    const atomic = parseTransferAtomic(ix);
    if (atomic == null || atomic <= 0n) continue;
    let sender = "";
    try {
      const acc = await conn.getParsedAccountInfo(new PublicKey(sourceAta), "confirmed");
      sender = String(acc?.value?.data?.parsed?.info?.owner || "").trim();
    } catch (_) {}
    if (!sender) sender = String(info.authority || info.owner || "").trim();
    if (!sender) continue;
    candidates.push({ senderPubkey: sender, amountAtomic: atomic.toString() });
  }
  if (!candidates.length) return { ok: false, reason: "sender_not_found" };
  candidates.sort((a, b) => (BigInt(b.amountAtomic) > BigInt(a.amountAtomic) ? 1 : -1));
  return { ok: true, senderPubkey: candidates[0].senderPubkey, transferAtomic: candidates[0].amountAtomic };
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
  const sender = await inferSenderFromStableDepositTx(conn, tx, treasuryAddress, USDC_MINT_MAINNET);
  if (!sender.ok) return { ok: false, reason: sender.reason, creditedAtomic: delta.toString() };
  return { ok: true, creditedAtomic: delta.toString(), senderPubkey: sender.senderPubkey };
}

async function verifyStableDepositTx(conn, signature, treasuryAddress, mintBase58, minAtomic) {
  const tx = await conn.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) return { ok: false, reason: "tx_not_found" };
  if (tx.meta?.err) return { ok: false, reason: "tx_failed", err: tx.meta.err };
  const delta = (() => {
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];
    const preAmt = balanceForOwnerMint(pre, treasuryAddress.trim(), mintBase58);
    const postAmt = balanceForOwnerMint(post, treasuryAddress.trim(), mintBase58);
    return postAmt - preAmt;
  })();
  if (delta < BigInt(minAtomic)) return { ok: false, reason: "insufficient_stable_credit", creditedAtomic: delta.toString() };
  const sender = await inferSenderFromStableDepositTx(conn, tx, treasuryAddress, mintBase58);
  if (!sender.ok) return { ok: false, reason: sender.reason, creditedAtomic: delta.toString() };
  return { ok: true, creditedAtomic: delta.toString(), senderPubkey: sender.senderPubkey };
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
 * @param {string} [opts.senderPubkey] - ignored; sender is inferred from deposit tx on-chain
 * @param {string} opts.treasuryAddress
 * @param {import("@solana/web3.js").Keypair} opts.signerKeypair
 * @param {string} [opts.depositTxSignature] - required for USDC/USDT: tx where sender transferred stable to treasury
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
  const senderInput = (opts.senderPubkey || "").trim();
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
  const atomic =
    opts.amountAtomic != null
      ? BigInt(String(opts.amountAtomic))
      : (opts.amount != null ? stableToAtomic(String(opts.amount)) : 1n);
  if (atomic <= 0n) {
    const err = new Error("amount must be positive when provided");
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  const priceInfo = getAsryPriceUsd();
  const rewardAsryAtomic = skipReward ? 0n : usdToAsryAtomic(rewardUsd, asryDecimals);
  /** 0.05% fee held back from each receive (for accounting / future distribution). */
  const feeAtomic = (atomic * BigInt(RECEIVE_FEE_BPS)) / 10000n;

  const out = {
    asset,
    senderPubkey: null,
    senderPubkeyInput: senderInput || null,
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

  const depSig = (opts.depositTxSignature || "").trim();
  if (!depSig) {
    const err = new Error("depositTxSignature required (payer stable transfer tx to treasury)");
    err.code = "MISSING_DEPOSIT_TX";
    throw err;
  }
  const conf = await waitForSignatureStatus(conn, depSig);
  if (!conf.ok) {
    out.receive = { depositTxSignature: depSig, confirmation: conf };
    out.reward = { skipped: true, reason: "deposit_not_confirmed" };
    return out;
  }

  if (asset === "USDT" || asset === "USDC") {
    const mint = asset === "USDT" ? USDT_MINT_MAINNET : USDC_MINT_MAINNET;
    const ver = await verifyStableDepositTx(conn, depSig, treasury, mint, atomic);
    out.receive = { depositTxSignature: depSig, verification: ver };
    if (!ver.ok) {
      out.reward = { skipped: true, reason: ver.reason, creditedAtomic: ver.creditedAtomic };
      return out;
    }
    out.senderPubkey = ver.senderPubkey || null;
    out.receive.feeAtomic = ((BigInt(ver.creditedAtomic) * BigInt(RECEIVE_FEE_BPS)) / 10000n).toString();
    out.feeAtomic = out.receive.feeAtomic;
    if (asset === "USDT") {
      const swap = await swapTreasuryUsdtToUsdcJupiter({
        treasuryAddress: treasury,
        signerKeypair: opts.signerKeypair,
        amountUsdtAtomic: BigInt(ver.creditedAtomic),
        dryRun: !!opts.dryRun,
        onlyDirectRoutes: opts.onlyDirectRoutes !== false,
        rpcUrl,
      });
      if (opts.dryRun) {
        out.receive.swap = { ...swap, confirmed: false, dryRun: true };
        out.reward = skipReward ? { skipped: true } : { previewAtomic: rewardAsryAtomic.toString() };
        return out;
      }
      const swapSig = swap.signature;
      if (!swapSig) {
        const err = new Error("USDT swap did not return signature");
        err.code = "SWAP_NO_SIG";
        throw err;
      }
      const swapConf = await waitForSignatureStatus(conn, swapSig);
      out.receive.swap = {
        swapSignature: swapSig,
        explorerUrl: swap.explorerUrl,
        confirmation: swapConf,
      };
      if (!swapConf.ok) {
        out.reward = { skipped: true, reason: "swap_not_confirmed" };
        return out;
      }
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
  if (!out.senderPubkey) {
    const err = new Error("sender could not be inferred from deposit tx");
    err.code = "SENDER_INFERENCE_FAILED";
    throw err;
  }

  try {
    const rewardSig = await sendAsryRewardToSender({
      connection: conn,
      treasuryKeypair: opts.signerKeypair,
      recipientPubkey: out.senderPubkey,
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
