const { postChat } = require('../services/genaiClient');
const asyncHandler = require('../utils/asyncHandler');

const postAssistantChat = asyncHandler(async (req, res) => {
  const { message, sessionId } = req.body;
  const walletAddress = req.user?.walletAddress || null;

  const retrieved_data = { gridSummary: true, walletConnected: !!walletAddress };

  let chatResponse;
  try {
    chatResponse = await postChat({ message, retrieved_data });
  } catch (error) {
    return res.status(503).json({
      success: false,
      message: 'GenAI service unavailable',
      details: error.message,
    });
  }

  if (!chatResponse.ok) {
    const errorText = await chatResponse.text();
    return res.status(chatResponse.status).json({
      success: false,
      message: 'Error communicating with GenAI service',
      details: errorText,
    });
  }

  const chatResult = await chatResponse.json();

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
