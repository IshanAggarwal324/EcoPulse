const router = require('express').Router();
const { getAnomalies } = require('../controllers/anomalyController');
const { protect } = require('../middleware/auth');
const { createAnomalyRateLimiter } = require('../middleware/rateLimit');

const anomalyLimiter = createAnomalyRateLimiter();

// Ownership/authorization is enforced inside the controller (IDOR guard) and
// the guardedUser chain is applied at the v1 mount. protect + rate limit are
// re-applied here to mirror the forecast route convention.
router.get('/', protect, anomalyLimiter, getAnomalies);

module.exports = router;
