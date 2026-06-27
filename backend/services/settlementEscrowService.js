/**
 * Settlement ⇄ Escrow resolution — Module 6.4.5
 *
 * Escrow and Settlement are written by independent event processors and have no
 * hard foreign key between them. This service resolves the escrow for a given
 * settlement:
 *   1. explicit `escrowRef` (preferred, deterministic), else
 *   2. a deterministic match on (chainId, contractAddress, listingId, buyer,
 *      seller) — the fields both records are guaranteed to share for the same
 *      purchase.
 *
 * `resolveEscrowBatch` resolves a page of settlements in a bounded number of
 * queries (one for explicit refs, one candidate query) so list endpoints do not
 * go N+1.
 */

const Escrow = require('../models/Escrow');

const matchFilter = (doc) => {
  if (!doc) return null;
  const f = { chainId: doc.chainId, contractAddress: doc.contractAddress };
  if (doc.listingId != null) f.listingId = doc.listingId;
  if (doc.buyer) f.buyer = doc.buyer;
  if (doc.seller) f.seller = doc.seller;
  return f;
};

const samePurchase = (esc, doc) =>
  esc &&
  esc.chainId === doc.chainId &&
  esc.contractAddress === doc.contractAddress &&
  (doc.listingId == null || esc.listingId === doc.listingId) &&
  (!doc.buyer || esc.buyer === doc.buyer) &&
  (!doc.seller || esc.seller === doc.seller);

const resolveEscrowForSettlement = async (doc) => {
  if (!doc) return null;
  if (doc.escrowRef) {
    const byRef = await Escrow.findById(doc.escrowRef).lean().catch(() => null);
    if (byRef) return byRef;
  }
  const f = matchFilter(doc);
  if (!f) return null;
  const matched = await Escrow.findOne(f).sort({ createdAt: -1 }).lean();
  return matched || null;
};

const resolveEscrowBatch = async (docs) => {
  const out = new Map();
  if (!Array.isArray(docs) || docs.length === 0) return out;

  const refIds = [...new Set(docs.map((d) => d.escrowRef).filter(Boolean))];
  const byRef = new Map();
  if (refIds.length) {
    const found = await Escrow.find({ _id: { $in: refIds } }).lean();
    found.forEach((e) => byRef.set(String(e._id), e));
  }

  const chainIds = [...new Set(docs.map((d) => d.chainId).filter((x) => x != null))];
  const contracts = [...new Set(docs.map((d) => d.contractAddress).filter((x) => x != null))];
  const listingIds = [...new Set(docs.map((d) => d.listingId).filter((x) => x != null))];
  if (!chainIds.length || !contracts.length) return out;

  const candidateQ = {
    chainId: { $in: chainIds },
    contractAddress: { $in: contracts },
  };
  if (listingIds.length) candidateQ.listingId = { $in: listingIds };
  const candidates = await Escrow.find(candidateQ).lean();

  for (const d of docs) {
    let esc = d.escrowRef ? byRef.get(String(d.escrowRef)) || null : null;
    if (!esc) esc = candidates.find((c) => samePurchase(c, d)) || null;
    out.set(String(d._id), esc);
  }
  return out;
};

module.exports = { resolveEscrowForSettlement, resolveEscrowBatch, samePurchase };
