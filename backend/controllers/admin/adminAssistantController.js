const { reindexAssistantDocs, GenaiServiceError } = require('../../services/genaiClient');
const assistantMetrics = require('../../services/assistantMetrics');
const asyncHandler = require('../../utils/asyncHandler');

// Sub-module 3.1.4 — rebuilds the GenAI doc RAG embedding cache. Admin + internal
// API key only (the admin route guards the caller; the GenAI middleware guards
// the internal hop). Only the configured docs directory is ever indexed.
const reindexAssistant = asyncHandler(async (req, res) => {
  let result;
  try {
    result = await reindexAssistantDocs();
  } catch (error) {
    if (error instanceof GenaiServiceError) {
      return res.status(error.status).json({
        success: false,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }

  res.status(200).json({
    success: true,
    data: result,
  });
});

// Sub-module 3.4.2 — aggregated assistant analytics (intent distribution,
// retrieval hit rate, doc chunk usage). Counters only — never chat content.
const getAssistantAnalytics = asyncHandler(async (req, res) => {
  const data = await assistantMetrics.getAnalytics();
  res.status(200).json({ success: true, data });
});

module.exports = {
  reindexAssistant,
  getAssistantAnalytics,
};
