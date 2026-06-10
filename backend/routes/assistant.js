const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { createChatRateLimiter, createReportRateLimiter } = require('../middleware/rateLimit');
const { getReportPreview, generateReport } = require('../controllers/reportController');
const { postAssistantChat } = require('../controllers/assistantController');

const chatLimiter = createChatRateLimiter();
const reportLimiter = createReportRateLimiter();

router.post('/chat', protect, chatLimiter, postAssistantChat);
router.post('/report', protect, reportLimiter, generateReport);
router.get('/report/preview', protect, getReportPreview);

module.exports = router;
