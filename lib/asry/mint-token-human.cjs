/**
 * Reusable: mint a human-readable amount of an SPL token to a destination wallet.
 * Intended for AMM, rewards, and other flows. Caller provides signer (must hold mint authority).
 */
const { Connection, PublicKey } = require("@solana/web3.js");
const { getMint, getOrCreateAssociatedTokenAccount, mintTo } = require("@solana/spl-token");

/**
 * Convert human-readable token amount to atomic (smallest) units.
 * @param {number|string} amountHuman - e.g. 100 for 100 tokens
 * @param {number} decimals - token decimals (0–9)
 * @returns {bigint} amount in smallest units
 */
function humanAmountToAtomic(amountHuman, decimals) {
  const n = Number(amountHuman);
  if (!Number.isFinite(n) || n <= 0) throw new Error("amountHuman must be a positive number");
  const dec = Math.min(9, Math.max(0, decimals));
  const factor = 10 ** dec;
  const raw = Math.floor(n * factor + 1e-9);
  if (raw <= 0) throw new Error("amountHuman too small for decimals");
  return BigInt(raw);
}

/**
 * Mint tokens (human amount) to a destination wallet. Creates destination ATA if needed.
 * @param {{
 *   mintAddress: string,
 *   amountHuman: number|string,
 *   decimals?: number,
 *   destinationOwner: string,
 *   signerKeypair: import("@solana/web3.js").Keypair,
 *   connection?: import("@solana/web3.js").Connection,
 *   rpcUrl?: string,
 * }} opts
 * @returns {Promise<{ signature: string, explorerUrl: string, amountAtomic: string }>}
 */
async function mintTokenHuman(opts) {
  const mintAddress = (opts.mintAddress || "").trim();
  const destinationOwner = (opts.destinationOwner || "").trim();
  const signerKeypair = opts.signerKeypair;
  if (!mintAddress || !destinationOwner || !signerKeypair) {
    throw new Error("mintAddress, destinationOwner, and signerKeypair are required");
  }

  const rpcUrl = opts.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const connection = opts.connection || new Connection(rpcUrl);
  const mint = new PublicKey(mintAddress);
  const destination = new PublicKey(destinationOwner);

  let decimals = opts.decimals;
  if (decimals == null || decimals < 0 || decimals > 9) {
    const mintInfo = await getMint(connection, mint);
    decimals = mintInfo.decimals;
  }

  const amountAtomic = humanAmountToAtomic(opts.amountHuman, decimals);

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    signerKeypair,
    mint,
    destination
  );

  const signature = await mintTo(
    connection,
    signerKeypair,
    mint,
    ata.address,
    signerKeypair.publicKey,
    amountAtomic
  );

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amountAtomic: amountAtomic.toString(),
  };
}

module.exports = {
  humanAmountToAtomic,
  mintTokenHuman,
};
