const { reindexAssistantDocs, GenaiServiceError } = require('../../services/genaiClient');
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

module.exports = {
  reindexAssistant,
};
