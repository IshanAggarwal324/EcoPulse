/**
 * Drops undefined / null entries so a partial update never overwrites a stored
 * value with null. Used by the escrow/dispute mirrors: each on-chain event only
 * knows part of a record (e.g. "released" does not carry the buyer, seller or
 * amount), and the stored fields from earlier events must survive.
 */
const compactUpdate = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));

module.exports = { compactUpdate };
