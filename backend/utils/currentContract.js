/**
 * Filter that limits Trade lookups to the EnergyTrading contract currently in use.
 *
 * Listing ids are per contract: each deployment numbers its listings from 0.
 * After the marketplace contract is redeployed (new ENERGY_TRADING_ADDRESS), trades
 * indexed from the previous contract share ids with the new one, so any lookup
 * that finds a trade by `listingId` alone would return the wrong contract's row.
 * Add this filter to such lookups.
 *
 * Trade history/analytics that intentionally span every contract do not use it.
 * When ENERGY_TRADING_ADDRESS is unset it returns `{}` (no restriction).
 */
const currentTradingContractFilter = () => {
  const address = String(process.env.ENERGY_TRADING_ADDRESS || '').trim().toLowerCase();
  return address ? { contractAddress: address } : {};
};

module.exports = { currentTradingContractFilter };
