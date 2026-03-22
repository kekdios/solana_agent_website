/**
 * Orca Whirlpool swap fee from on-chain `fee_rate` (u16).
 * Documented: swap_fee = floor(input_amount * fee_rate / 1_000_000).
 * Display as % of trade: (fee_rate / 1_000_000) * 100.
 * @see https://dev.orca.so/Architecture%20Overview/Whirlpool%20Fees/
 */

function whirlpoolSwapFeeRateToPercent(feeRate) {
  const n = Number(feeRate);
  if (!Number.isFinite(n) || n < 0) return null;
  return (n / 1_000_000) * 100;
}

/**
 * @param {number|string} feeRate raw Whirlpool fee_rate
 * @param {number} [decimalPlaces=4]
 * @returns {string} e.g. "0.3000%" or "—"
 */
function formatWhirlpoolSwapFeePercent(feeRate, decimalPlaces = 4) {
  const p = whirlpoolSwapFeeRateToPercent(feeRate);
  if (p == null) return "—";
  return p.toFixed(decimalPlaces) + "%";
}

module.exports = {
  whirlpoolSwapFeeRateToPercent,
  formatWhirlpoolSwapFeePercent,
};
