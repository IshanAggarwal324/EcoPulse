const mongoose = require('mongoose');
const ReportJob = require('../../models/ReportJob');
const User = require('../../models/User');
const { parsePagination, paginateResults } = require('../../utils/paginate');
const asyncHandler = require('../../utils/asyncHandler');

const listReportJobs = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { status, userId, period, delivery, since, until } = req.query;

  const filter = {};

  if (status && ['pending', 'sent', 'failed'].includes(status)) {
    filter.status = status;
  }

  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    filter.userId = userId;
  }

  if (period && ['7d', '14d', '30d'].includes(period)) {
    filter.period = period;
  }

  if (delivery && ['chat', 'email'].includes(delivery)) {
    filter.delivery = delivery;
  }

  if (since) {
    filter.createdAt = { ...filter.createdAt, $gte: new Date(since) };
  }

  if (until) {
    filter.createdAt = { ...filter.createdAt, $lte: new Date(until) };
  }

  const [jobs, total] = await Promise.all([
    ReportJob.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name email')
      .lean(),
    ReportJob.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: jobs,
    meta: paginateResults({ page, limit, total }),
  });
});

const getReportJob = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid report job ID' });
  }

  const job = await ReportJob.findById(id).populate('userId', 'name email').lean();

  if (!job) {
    return res.status(404).json({ success: false, message: 'Report job not found' });
  }

  res.status(200).json({
    success: true,
    data: job,
  });
});

const retryReportJob = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'Invalid report job ID' });
  }

  const job = await ReportJob.findById(id).populate('userId', 'name email');

  if (!job) {
    return res.status(404).json({ success: false, message: 'Report job not found' });
  }

  if (job.status !== 'failed') {
    return res.status(400).json({ success: false, message: 'Only failed report jobs can be retried' });
  }

  if (job.delivery !== 'email') {
    return res.status(400).json({ success: false, message: 'Retry is only supported for email delivery jobs' });
  }

  const {
    isConfigured: isEmailConfigured,
    canSendEmail,
    sendReport,
    buildReportEmailSubject,
    buildReportEmailBody,
  } = require('../../services/emailService');

  if (!isEmailConfigured()) {
    return res.status(503).json({ success: false, message: 'Email delivery is not configured on the server.' });
  }

  const user = await User.findById(job.userId._id || job.userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Report job owner not found' });
  }

  const emailCheck = canSendEmail(user);
  if (!emailCheck.allowed) {
    return res.status(400).json({ success: false, message: emailCheck.reason });
  }

  try {
    const reportService = require('../../services/reportService');
    const { postNarrate } = require('../../services/genaiClient');
    const { generateReportPdf, buildReportFilename } = require('../../services/pdfReportService');

    const walletAddress = user.walletAddress || null;
    const reportData = await reportService.buildReportMetrics({ period: job.period, walletAddress, scope: job.scope });
    const narrateResult = await postNarrate(reportData, null);
    const pdfBuffer = await generateReportPdf({ metrics: reportData, narrative: narrateResult.summary, user });

    const filename = buildReportFilename(job.period);
    const subject = buildReportEmailSubject(job.period);
    const html = buildReportEmailBody({ userName: user.name, period: job.period });

    await sendReport({ to: user.email, subject, html, pdfBuffer, filename });

    job.status = 'sent';
    job.sentAt = new Date();
    job.error = undefined;
    await job.save();

    res.status(200).json({
      success: true,
      message: 'Report email re-sent successfully',
      data: job,
    });
  } catch (sendError) {
    job.error = sendError.message;
    await job.save();

    res.status(500).json({
      success: false,
      message: `Retry failed: ${sendError.message}`,
    });
  }
});

module.exports = {
  listReportJobs,
  getReportJob,
  retryReportJob,
};
