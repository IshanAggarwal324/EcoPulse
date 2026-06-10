const { postChat, GenaiServiceError } = require('../services/genaiClient');
const asyncHandler = require('../utils/asyncHandler');

const postAssistantChat = asyncHandler(async (req, res) => {
  const { message, sessionId } = req.body;
  const walletAddress = req.user?.walletAddress || null;

  const retrieved_data = { gridSummary: true, walletConnected: !!walletAddress };

  let chatResult;
  try {
    chatResult = await postChat({ message, retrieved_data });
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
      sources: [],
      disclaimer: chatResult.disclaimer,
      sessionId: sessionId || null,
    },
  });
});

module.exports = { postAssistantChat };
