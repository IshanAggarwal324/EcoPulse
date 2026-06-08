const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getReportPreview } = require('../controllers/reportController');

router.get('/report/preview', protect, getReportPreview);

module.exports = router;
