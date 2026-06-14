const reportService = require('../services/reportService');
const { postNarrate, GenaiServiceError } = require('../services/genaiClient');
const { generateReportPdf, buildReportFilename } = require('../services/pdfReportService');
const {
  isConfigured: isEmailConfigured,
  canSendEmail,
  sendReport,
  buildReportEmailSubject,
  buildReportEmailBody,
} = require('../services/emailService');
const ReportJob = require('../models/ReportJob');
const asyncHandler = require('../utils/asyncHandler');
const auditService = require('../services/auditService');

const VALID_PERIODS = ['7d', '14d', '30d'];
const VALID_SCOPES = ['personal', 'grid', 'both'];
const VALID_DELIVERIES = ['chat', 'email'];

function validateReportRequest({ period, scope, delivery }) {
  const errors = [];

  if (!period || !VALID_PERIODS.includes(period)) {
    errors.push(`Invalid period "${period}". Must be one of: ${VALID_PERIODS.join(', ')}`);
  }

  if (!scope || !VALID_SCOPES.includes(scope)) {
    errors.push(`Invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`);
  }

  if (!delivery || !VALID_DELIVERIES.includes(delivery)) {
    errors.push(`Invalid delivery "${delivery}". Must be one of: ${VALID_DELIVERIES.join(', ')}`);
  }

  if (errors.length > 0) {
    return { valid: false, status: 400, message: errors.join(' ') };
  }

  return { valid: true };
}

const SECTION_SOURCES = {
  gridEnergy: { type: 'analytics', label: 'Grid energy totals', endpoint: '/analytics/energy' },
  gridTrading: { type: 'analytics', label: 'Grid trading stats', endpoint: '/analytics/trades' },
  nodeOverview: { type: 'analytics', label: 'Node overview', endpoint: '/analytics/nodes' },
  personalProfit: { type: 'analytics', label: 'Wallet profit', endpoint: '/analytics/wallet' },
  carbon: { type: 'analytics', label: 'Carbon credits', endpoint: '/analytics/carbon' },
};

function buildSourcesFromMetrics(metrics) {
  const sources = [];
  for (const [key, source] of Object.entries(SECTION_SOURCES)) {
    if (metrics[key] != null) {
      sources.push(source);
    }
  }
  return sources;
}

const getReportPreview = asyncHandler(async (req, res) => {
  const period = req.query.period || '7d';
  const scope = req.query.scope || 'both';
  const requestedWallet = req.query.wallet ? String(req.query.wallet).toLowerCase() : null;
  const userWallet = req.user?.walletAddress ? String(req.user.walletAddress).toLowerCase() : null;
  const isPrivileged = req.user?.role === 'admin' || req.user?.role === 'moderator';

  if (!isPrivileged && requestedWallet && userWallet && requestedWallet !== userWallet) {
    return res.status(403).json({
      success: false,
      message: 'You can only preview reports for your own wallet',
    });
  }

  const walletAddress = isPrivileged
    ? (requestedWallet || userWallet || null)
    : (userWallet || null);

  const metrics = await reportService.buildReportMetrics({ period, walletAddress, scope });

  res.status(200).json({
    success: true,
    data: metrics,
  });
});

const generateReport = asyncHandler(async (req, res) => {
  const { period, scope, delivery } = req.body;

  const validation = validateReportRequest({ period, scope, delivery });
  if (!validation.valid) {
    return res.status(validation.status).json({ success: false, message: validation.message });
  }

  const walletAddress = req.user?.walletAddress || null;
  const reportData = await reportService.buildReportMetrics({ period, walletAddress, scope });

  const { meta, periodLabel, ...metricsSections } = reportData;
  const sources = buildSourcesFromMetrics(metricsSections);

  let narrateResult;
  try {
    narrateResult = await postNarrate(reportData, null);
  } catch (error) {
    if (error instanceof GenaiServiceError) {
      return res.status(error.status).json({ success: false, message: error.message, details: error.details });
    }
    throw error;
  }

  if (delivery === 'email') {
    const emailCheck = canSendEmail(req.user);
    if (!emailCheck.allowed) {
      return res.status(400).json({ success: false, message: emailCheck.reason });
    }
    if (!isEmailConfigured()) {
      return res.status(503).json({ success: false, message: 'Email delivery is not configured on the server.' });
    }

    const pdfBuffer = await generateReportPdf({
      metrics: reportData,
      narrative: narrateResult.summary,
      user: req.user,
    });

    const filename = buildReportFilename(period);
    const subject = buildReportEmailSubject(period);
    const html = buildReportEmailBody({ userName: req.user.name, period });

    try {
      await sendReport({
        to: req.user.email,
        subject,
        html,
        pdfBuffer,
        filename,
      });

      const reportJob = await ReportJob.create({
        userId: req.user._id,
        period,
        scope,
        delivery: 'email',
        status: 'sent',
        sentAt: new Date(),
      });

      await auditService.log({
        actor: req.user,
        action: 'REPORT_GENERATED',
        resourceType: 'report_job',
        resourceId: reportJob._id,
        metadata: { period, scope, delivery: 'email', status: 'sent' },
        req,
      });
    } catch (sendError) {
      const failedJob = await ReportJob.create({
        userId: req.user._id,
        period,
        scope,
        delivery: 'email',
        status: 'failed',
        error: sendError.message,
      });

      await auditService.log({
        actor: req.user,
        action: 'REPORT_GENERATED',
        resourceType: 'report_job',
        resourceId: failedJob._id,
        metadata: { period, scope, delivery: 'email', status: 'failed', error: sendError.message },
        req,
        severity: 'warn',
      });

      return res.status(200).json({
        success: true,
        data: {
          fallback: 'chat',
          summary: narrateResult.summary,
          highlights: narrateResult.highlights,
          metrics: metricsSections,
          meta,
          sources,
          disclaimer: narrateResult.disclaimer,
          message: 'Email delivery failed. Showing summary in chat instead.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        status: 'queued',
        message: `Detailed report sent to ${req.user.email}`,
        reportId: reportJob._id,
      },
    });
  }

  res.status(200).json({
    success: true,
    data: {
      summary: narrateResult.summary,
      highlights: narrateResult.highlights,
      metrics: metricsSections,
      meta,
      walletWarning: meta?.walletWarning || null,
      sources,
      disclaimer: narrateResult.disclaimer,
    },
  });

  await auditService.log({
    actor: req.user,
    action: 'REPORT_GENERATED',
    resourceType: 'report_job',
    resourceId: null,
    metadata: { period, scope, delivery: 'chat' },
    req,
  });
});

module.exports = { validateReportRequest, buildSourcesFromMetrics, getReportPreview, generateReport };
