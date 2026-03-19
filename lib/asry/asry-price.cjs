/**
 * ASRY reference price in USD (for reward sizing, display).
 * Replace with pool mid / oracle when live.
 */

/** Treasury ASRY token mint (mainnet). https://explorer.solana.com/address/3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw */
const ASRY_MINT_TREASURY_MAINNET = "3xKw9DpMZSmVTEpEvTwMd2Qm4T4FGAyUDmmkZEroBzZw";

/** Fixed policy: $100 per 1 ASRY until replaced by market pricing. */
const ASRY_PRICE_USD_FIXED = 100;

/**
 * @returns {{ priceUsdPerAsry: number, source: string, asOf: string }}
 */
function getAsryPriceUsd() {
  return {
    priceUsdPerAsry: ASRY_PRICE_USD_FIXED,
    source: "fixed_100_usd_per_asry",
    asOf: new Date().toISOString(),
  };
}

/**
 * How many ASRY (smallest units) equals `usdAmount` dollars at current price.
 * @param {number} usdAmount - e.g. 0.5 for fifty cents
 * @param {number} decimals - ASRY token decimals (default 9)
 */
function usdToAsryAtomic(usdAmount, decimals = 9) {
  const { priceUsdPerAsry } = getAsryPriceUsd();
  if (priceUsdPerAsry <= 0) throw new Error("invalid ASRY price");
  const asryHuman = usdAmount / priceUsdPerAsry;
  const factor = 10 ** decimals;
  const raw = asryHuman * factor;
  const floored = Math.floor(raw + 1e-9);
  return BigInt(floored);
}

module.exports = {
  getAsryPriceUsd,
  usdToAsryAtomic,
  ASRY_PRICE_USD_FIXED,
  ASRY_MINT_TREASURY_MAINNET,
};
