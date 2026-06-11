const { postChat, GenaiServiceError } = require('../services/genaiClient');
const { classifyIntent } = require('../services/intentClassifier');
const { retrieveForIntent } = require('../services/retrievalService');
const asyncHandler = require('../utils/asyncHandler');

const postAssistantChat = asyncHandler(async (req, res) => {
  const { message, sessionId, conversationHistory } = req.body;
  const walletAddress = req.user?.walletAddress || null;

  const { intent, period } = classifyIntent(message);
  const { retrieved_data, sources } = await retrieveForIntent(intent, { walletAddress, period });

  let chatResult;
  try {
    chatResult = await postChat({
      message,
      retrieved_data,
      conversation_history: Array.isArray(conversationHistory) ? conversationHistory.slice(-12) : [],
    });
  } catch (error) {
    if (error instanceof GenaiServiceError) {
      return res.status(error.status).json({ success: false, message: error.message, details: error.details });
    }
    throw error;
  }

  res.status(200).json({
    success: true,
    data: {
      reply: chatResult.reply,
      sources,
      disclaimer: chatResult.disclaimer,
      sessionId: sessionId || null,
    },
  });
});

module.exports = { postAssistantChat };
