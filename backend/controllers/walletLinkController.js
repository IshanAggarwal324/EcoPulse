const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');
const User = require('../models/User');
const auditService = require('../services/auditService');
const walletLink = require('../services/walletLinkService');
const { ADDRESS_RE } = require('../services/walletLinkService');

const toUserResponse = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  walletAddress: user.walletAddress,
  walletLinkedAt: user.walletLinkedAt ?? null,
  role: user.role,
  isBanned: user.isBanned,
  isEmailVerified: user.isEmailVerified ?? false,
  mustChangePassword: user.mustChangePassword ?? false,
  preferences: user.preferences,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

/**
 * GET /auth/wallet/challenge?wallet=0x...
 * Returns the EIP-712 typed data the client must sign. The nonce is server-
 * generated and bound to (user, wallet); it is single-use and short-lived.
 */
const getChallenge = asyncHandler(async (req, res) => {
  const wallet = (req.query.wallet || req.body?.wallet || '').trim();
  if (!ADDRESS_RE.test(wallet)) {
    throw new ApiError('A valid wallet address is required', 400, 'INVALID_WALLET');
  }

  const { typedData, expiresAt } = await walletLink.issueChallenge(req.user, wallet);

  res.status(200).json({
    success: true,
    data: { typedData, expiresAt, action: walletLink.WALLET_LINK_ACTION },
  });
});

/**
 * POST /auth/wallet/link  { wallet, signature }
 * Verifies the signature against the server-stored challenge and atomically
 * claims the wallet for the authenticated user.
 */
const linkWallet = asyncHandler(async (req, res) => {
  const { wallet, signature } = req.body || {};
  const updated = await walletLink.linkWallet(req.user, { wallet, signature });

  await auditService.log({
    actor: updated,
    action: 'WALLET_LINKED',
    resourceType: 'user',
    resourceId: updated._id,
    metadata: { walletAddress: updated.walletAddress },
    req,
    severity: 'critical',
  });

  res.status(200).json({
    success: true,
    message: 'Wallet linked successfully',
    data: { user: toUserResponse(updated) },
  });
});

/**
 * DELETE /auth/wallet/unlink  { currentPassword? }
 * Clears the wallet link. Self-service requires a password re-check so a stolen
 * access token cannot unlink (and relink) the victim's wallet. Admins may
 * unlink any user without the password.
 */
const unlinkWallet = asyncHandler(async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const targetId = isAdmin && req.body?.userId ? req.body.userId : req.user._id;

  const fresh = await User.findById(targetId).select('+password');
  if (!fresh) {
    throw new ApiError('User not found', 404, 'USER_NOT_FOUND');
  }
  if (!fresh.walletAddress) {
    throw new ApiError('No wallet is linked to this account', 400, 'NO_WALLET_LINKED');
  }

  if (!isAdmin) {
    // Re-authentication: the access token alone is insufficient to drop a wallet.
    const { currentPassword } = req.body || {};
    if (!currentPassword) {
      throw new ApiError('Your current password is required to unlink your wallet', 400, 'PASSWORD_REQUIRED');
    }
    const ok = await bcrypt.compare(currentPassword, fresh.password);
    if (!ok) {
      throw new ApiError('Current password is incorrect', 401, 'INVALID_CREDENTIALS');
    }
  }

  const previousWallet = fresh.walletAddress;
  const updated = await walletLink.unlinkWallet(fresh);

  await auditService.log({
    actor: req.user,
    action: 'WALLET_UNLINKED',
    resourceType: 'user',
    resourceId: updated._id,
    metadata: {
      walletAddress: previousWallet,
      selfService: String(updated._id) === String(req.user._id),
    },
    req,
    severity: 'critical',
  });

  res.status(200).json({
    success: true,
    message: 'Wallet unlinked successfully',
    data: { user: toUserResponse(updated) },
  });
});

module.exports = { getChallenge, linkWallet, unlinkWallet };
