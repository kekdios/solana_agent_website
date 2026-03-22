/**
 * Read Orca Whirlpool state from Solana RPC (no Orca REST API).
 * Works for any mainnet Whirlpool account the indexer may omit (e.g. no “base” token in Orca’s product sense).
 */
const { PublicKey } = require("@solana/web3.js");
const { getMint } = require("@solana/spl-token");
const { formatWhirlpoolSwapFeePercent } = require("./whirlpool-fee-format.cjs");

const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const DISC_LEN = 8;
/** Discriminator + Whirlpool fields through reward_last_updated_timestamp (see orca-so/whirlpools Whirlpool struct). */
const MIN_DATA_LEN = DISC_LEN + 261;

function readU128LE(buf, offset) {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return lo | (hi << 64n);
}

function readPubkey(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

function decodeMplTokenMetadataNameSymbol(data) {
  if (!data || !Buffer.isBuffer(data) || data.length < 100) return { name: null, symbol: null };
  try {
    let i = 1 + 32 + 32;
    const readStr = () => {
      const len = data.readUInt32LE(i);
      i += 4;
      const s = data.slice(i, i + len).toString("utf8").replace(/\0/g, "").trim();
      i += len;
      return s;
    };
    const name = readStr();
    const symbol = readStr();
    return { name, symbol };
  } catch (_) {
    return { name: null, symbol: null };
  }
}

async function fetchMplTokenMetadataNameSymbol(connection, mintPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mintPk.toBuffer()],
    MPL_TOKEN_METADATA
  );
  const acc = await connection.getAccountInfo(pda);
  if (!acc || !acc.data) return { name: null, symbol: null };
  return decodeMplTokenMetadataNameSymbol(Buffer.from(acc.data));
}

/**
 * @param {Buffer} dataBuf full account data (includes 8-byte Anchor discriminator)
 * @returns {object|null}
 */
function decodeWhirlpoolAccount(dataBuf) {
  if (!Buffer.isBuffer(dataBuf) || dataBuf.length < MIN_DATA_LEN) return null;
  const b = dataBuf;
  let o = DISC_LEN;
  o += 32; // whirlpools_config
  o += 1; // whirlpool_bump
  const tickSpacing = b.readUInt16LE(o);
  o += 2;
  o += 2; // fee_tier_index_seed
  const feeRate = b.readUInt16LE(o);
  o += 2;
  const protocolFeeRate = b.readUInt16LE(o);
  o += 2;
  const liquidity = readU128LE(b, o);
  o += 16;
  const sqrtPrice = readU128LE(b, o);
  o += 16;
  const tickCurrentIndex = b.readInt32LE(o);
  o += 4;
  o += 8; // protocol_fee_owed_a
  o += 8; // protocol_fee_owed_b
  const tokenMintA = readPubkey(b, o);
  o += 32;
  const tokenVaultA = readPubkey(b, o);
  o += 32;
  o += 16; // fee_growth_global_a
  const tokenMintB = readPubkey(b, o);
  o += 32;
  const tokenVaultB = readPubkey(b, o);
  return {
    tickSpacing,
    feeRate,
    protocolFeeRate,
    liquidity,
    sqrtPrice,
    tickCurrentIndex,
    tokenMintA,
    tokenVaultA,
    tokenMintB,
    tokenVaultB,
  };
}

/** Approximate human “token B per 1 token A” from sqrt price Q64.64 and mint decimals. */
function sqrtPriceToApproxTokenBPerTokenA(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrt = BigInt(String(sqrtPriceX64));
  if (sqrt <= 0n) return null;
  const q64 = 1n << 64n;
  const num = sqrt * sqrt;
  const den = q64 * q64;
  const decDiff = Number(decimalsA) - Number(decimalsB);
  let numerator = num;
  let denominator = den;
  try {
    if (decDiff >= 0) {
      const factor = 10n ** BigInt(Math.min(decDiff, 24));
      numerator = num * factor;
    } else {
      const factor = 10n ** BigInt(Math.min(-decDiff, 24));
      denominator = den * factor;
    }
    const intPart = numerator / denominator;
    const frac = numerator % denominator;
    if (frac === 0n) return intPart.toString();
    const fracDigits = 8n;
    const fracScaled = (frac * 10n ** fracDigits) / denominator;
    let fracStr = fracScaled.toString().padStart(8, "0").replace(/0+$/, "");
    return fracStr ? `${intPart}.${fracStr}` : intPart.toString();
  } catch (_) {
    return null;
  }
}

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} poolAddressStr base58 Whirlpool pubkey
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: string, message?: string }>}
 */
async function fetchWhirlpoolPoolFromRpc(connection, poolAddressStr) {
  let poolPk;
  try {
    poolPk = new PublicKey(poolAddressStr);
  } catch (_) {
    return { ok: false, error: "invalid_pool_pubkey" };
  }

  const acc = await connection.getAccountInfo(poolPk);
  if (!acc) return { ok: false, error: "pool_account_not_found" };
  if (!acc.owner.equals(WHIRLPOOL_PROGRAM_ID)) {
    return { ok: false, error: "not_whirlpool_account", message: `Owner is ${acc.owner.toBase58()}, expected Whirlpool program` };
  }

  const raw = Buffer.from(acc.data);
  const wh = decodeWhirlpoolAccount(raw);
  if (!wh) return { ok: false, error: "invalid_whirlpool_data" };

  const [mintAInfo, mintBInfo, balARes, balBRes, metaA, metaB] = await Promise.all([
    getMint(connection, wh.tokenMintA),
    getMint(connection, wh.tokenMintB),
    connection.getTokenAccountBalance(wh.tokenVaultA).catch(() => null),
    connection.getTokenAccountBalance(wh.tokenVaultB).catch(() => null),
    fetchMplTokenMetadataNameSymbol(connection, wh.tokenMintA),
    fetchMplTokenMetadataNameSymbol(connection, wh.tokenMintB),
  ]);

  const decA = mintAInfo.decimals;
  const decB = mintBInfo.decimals;
  const symA = metaA.symbol || "A";
  const symB = metaB.symbol || "B";
  const priceApprox = sqrtPriceToApproxTokenBPerTokenA(wh.sqrtPrice, decA, decB);

  const data = {
    address: poolPk.toBase58(),
    tokenMintA: wh.tokenMintA.toBase58(),
    tokenMintB: wh.tokenMintB.toBase58(),
    tokenVaultA: wh.tokenVaultA.toBase58(),
    tokenVaultB: wh.tokenVaultB.toBase58(),
    tokenBalanceA: balARes && balARes.value ? balARes.value.amount : null,
    tokenBalanceB: balBRes && balBRes.value ? balBRes.value.amount : null,
    tokenA: {
      address: wh.tokenMintA.toBase58(),
      decimals: decA,
      symbol: metaA.symbol || undefined,
    },
    tokenB: {
      address: wh.tokenMintB.toBase58(),
      decimals: decB,
      symbol: metaB.symbol || undefined,
    },
    feeRate: wh.feeRate,
    swapFeePercentDisplay: formatWhirlpoolSwapFeePercent(wh.feeRate),
    protocolFeeRate: wh.protocolFeeRate,
    tickSpacing: wh.tickSpacing,
    tickCurrentIndex: wh.tickCurrentIndex,
    liquidity: wh.liquidity.toString(),
    sqrtPrice: wh.sqrtPrice.toString(),
    poolType: "Whirlpool",
    poolDataSource: "solana_rpc",
    updatedAt: new Date().toISOString(),
    price: priceApprox != null ? priceApprox : undefined,
    tvlUsdc: undefined,
  };

  return { ok: true, data };
}

module.exports = {
  WHIRLPOOL_PROGRAM_ID,
  fetchWhirlpoolPoolFromRpc,
  decodeWhirlpoolAccount,
};
