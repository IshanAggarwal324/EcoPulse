const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { createChatRateLimiter, createReportRateLimiter, createPreviewRateLimiter } = require('../middleware/rateLimit');
const { getReportPreview, generateReport } = require('../controllers/reportController');
const { postAssistantChat } = require('../controllers/assistantController');

const chatLimiter = createChatRateLimiter();
const reportLimiter = createReportRateLimiter();
const previewLimiter = createPreviewRateLimiter();

router.post('/chat', protect, chatLimiter, postAssistantChat);
router.post('/report', protect, reportLimiter, generateReport);
router.get('/report/preview', protect, previewLimiter, getReportPreview);

module.exports = router;
