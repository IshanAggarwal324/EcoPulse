const mongoose = require('mongoose');
const User = require('../../models/User');
const EnergyNode = require('../../models/EnergyNode');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');
const auditService = require('../../services/auditService');
const { escapeRegex } = require('../../utils/validators');

const VALID_ROLES = ['user', 'admin', 'moderator'];

const toAdminUserResponse = (user, extra = {}) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  walletAddress: user.walletAddress,
  role: user.role,
  isBanned: user.isBanned,
  bannedAt: user.bannedAt,
  bannedReason: user.bannedReason,
  bannedBy: user.bannedBy,
  deletedAt: user.deletedAt,
  lastLoginAt: user.lastLoginAt,
  preferences: user.preferences,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  ...extra,
});

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { role, isBanned, search, includeDeleted } = req.query;

  const filter = {};

  if (role && VALID_ROLES.includes(role)) {
    filter.role = role;
  }

  if (isBanned !== undefined) {
    filter.isBanned = isBanned === 'true';
  }

  if (!includeDeleted || includeDeleted !== 'true') {
    filter.deletedAt = null;
  }

  if (search) {
    const term = escapeRegex(search.trim()).slice(0, 64);
    filter.$or = [
      { name: { $regex: term, $options: 'i' } },
      { email: { $regex: term, $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: users.map((u) => toAdminUserResponse(u)),
    meta: paginateResults({ page, limit, total }),
  });
});

const getUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid user ID' });
  }

  const user = await User.findById(id).lean();
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const nodeCount = await EnergyNode.countDocuments({ userId: id });

  res.status(200).json({
    success: true,
    data: toAdminUserResponse(user, { nodeCount }),
  });
});

const setRole = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid user ID' });
  }

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: `Role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  if (id === req.user._id.toString()) {
    return res.status(400).json({ success: false, message: 'You cannot change your own role' });
  }

  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (user.deletedAt) {
    return res.status(400).json({ success: false, message: 'Cannot change role of a deactivated user' });
  }

  const previousRole = user.role;
  user.role = role;
  await user.save();

  await auditService.log({
    actor: req.user,
    action: 'USER_ROLE_CHANGED',
    resourceType: 'user',
    resourceId: user._id,
    metadata: { previousRole, newRole: role },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: `User role updated to "${role}"`,
    data: toAdminUserResponse(user),
  });
});

const banUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid user ID' });
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Ban reason is required' });
  }

  if (id === req.user._id.toString()) {
    return res.status(400).json({ success: false, message: 'You cannot ban yourself' });
  }

  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (user.isBanned) {
    return res.status(400).json({ success: false, message: 'User is already banned' });
  }

  user.isBanned = true;
  user.bannedAt = new Date();
  user.bannedReason = reason.trim();
  user.bannedBy = req.user._id;
  await user.save();

  await auditService.log({
    actor: req.user,
    action: 'USER_BANNED',
    resourceType: 'user',
    resourceId: user._id,
    metadata: { reason: reason.trim(), userEmail: user.email },
    req,
    severity: 'critical',
  });

  res.status(200).json({
    success: true,
    message: 'User has been banned',
    data: toAdminUserResponse(user),
  });
});

const unbanUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid user ID' });
  }

  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (!user.isBanned) {
    return res.status(400).json({ success: false, message: 'User is not banned' });
  }

  user.isBanned = false;
  user.bannedAt = null;
  user.bannedReason = null;
  user.bannedBy = null;
  await user.save();

  await auditService.log({
    actor: req.user,
    action: 'USER_UNBANNED',
    resourceType: 'user',
    resourceId: user._id,
    metadata: { userEmail: user.email },
    req,
    severity: 'warn',
  });

  res.status(200).json({
    success: true,
    message: 'User has been unbanned',
    data: toAdminUserResponse(user),
  });
});

const deleteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid user ID' });
  }

  if (id === req.user._id.toString()) {
    return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
  }

  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (user.deletedAt) {
    return res.status(400).json({ success: false, message: 'User is already deactivated' });
  }

  user.deletedAt = new Date();
  await user.save();

  await auditService.log({
    actor: req.user,
    action: 'USER_DELETED',
    resourceType: 'user',
    resourceId: user._id,
    metadata: { userEmail: user.email, userName: user.name },
    req,
    severity: 'critical',
  });

  res.status(200).json({
    success: true,
    message: 'User has been deactivated',
    data: { _id: user._id, deletedAt: user.deletedAt },
  });
});

module.exports = {
  listUsers,
  getUser,
  setRole,
  banUser,
  unbanUser,
  deleteUser,
};
