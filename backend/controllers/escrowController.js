const escrowService = require('../services/escrowService');
const asyncHandler = require('../utils/asyncHandler');

const ESCROW_STATES = new Set(escrowService.STATE_INDEX);

/**
 * GET /api/v1/escrow
 * Lists escrow mirror records. Non-admins are scoped to their own wallet.
 */
const listEscrows = asyncHandler(async (req, res) => {
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'moderator';
  const wallet = isAdmin
    ? req.query.wallet || req.user?.walletAddress || null
    : req.user?.walletAddress || req.query.wallet || null;

  const state = req.query.state && ESCROW_STATES.has(req.query.state) ? req.query.state : null;

  const result = await escrowService.listEscrows({
    wallet,
    state,
    listingId: req.query.listingId,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data: result.data, meta: result.meta });
});

/**
 * GET /api/v1/escrow/:escrowId
 * Returns the mirror record, refreshed against the chain when possible.
 */
const getEscrow = asyncHandler(async (req, res) => {
  const escrowId = parseInt(req.params.escrowId, 10);
  if (Number.isNaN(escrowId) || escrowId < 0) {
    return res.status(400).json({ success: false, message: 'Invalid escrow ID' });
  }

  // Best-effort chain refresh so the UI never serves a stale terminal state.
  try {
    const BlockchainService = require('../services/blockchainService');
    const provider = BlockchainService.getEnergyEscrowContractReadOnly().runner?.provider;
    if (provider) {
      const network = await provider.getNetwork();
      const { energyEscrowAddress } = BlockchainService.getEscrowAddresses();
      await escrowService.syncEscrowMirror(escrowId, {
        chainId: Number(network.chainId),
        contractAddress: energyEscrowAddress,
      });
    }
  } catch {
    // Mirror may simply not exist yet; fall through to the DB read.
  }

  const escrow = await escrowService.getEscrowById({ escrowId });
  if (!escrow) {
    return res.status(404).json({ success: false, message: 'Escrow not found' });
  }

  // Enforce wallet scoping for non-admins.
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'moderator';
  const wallet = String(req.user?.walletAddress || '').toLowerCase();
  if (!isAdmin && wallet && escrow.buyer !== wallet && escrow.seller !== wallet) {
    return res.status(403).json({ success: false, message: 'Not authorized to view this escrow' });
  }

  res.status(200).json({ success: true, data: escrow });
});

module.exports = { listEscrows, getEscrow };
