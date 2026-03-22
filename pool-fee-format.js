/**
 * Browser helper: Orca Whirlpool swap fee display from raw `fee_rate`.
 * Keep in sync with lib/whirlpool-fee-format.cjs (same formula).
 * @see https://dev.orca.so/Architecture%20Overview/Whirlpool%20Fees/
 */
(function (w) {
  function formatSwapFeePercent(feeRate, decimalPlaces) {
    const places = decimalPlaces == null ? 4 : decimalPlaces;
    const n = Number(feeRate);
    if (!Number.isFinite(n) || n < 0) return "—";
    return ((n / 1_000_000) * 100).toFixed(places) + "%";
  }
  w.SolanaAgentWhirlpoolFee = { formatSwapFeePercent: formatSwapFeePercent };
})(typeof window !== "undefined" ? window : globalThis);
