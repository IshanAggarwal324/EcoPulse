const { postChat, fetchDocChunks, GenaiServiceError } = require('../services/genaiClient');
const { classifyIntent } = require('../services/intentClassifier');
const { retrieveForIntent } = require('../services/retrievalService');
const asyncHandler = require('../utils/asyncHandler');

const DOC_CHUNK_INTENTS = new Set(['general', 'faq']);

function buildDocSources(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const seen = new Set();
  const sources = [];

  for (const chunk of chunks) {
    const key = chunk.docId;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      type: 'doc',
      label: chunk.title || key.replace(/-/g, ' '),
      docId: key,
    });
  }

  return sources;
}

const postAssistantChat = asyncHandler(async (req, res) => {
  const { message, sessionId, conversationHistory } = req.body;
  const walletAddress = req.user?.walletAddress || null;

  const { intent, period } = classifyIntent(message);
  const { retrieved_data, sources } = await retrieveForIntent(intent, { walletAddress, period });

  let docChunks = null;
  let docSources = [];
  if (DOC_CHUNK_INTENTS.has(intent)) {
    const chunks = await fetchDocChunks(message);
    if (chunks.length > 0) {
      docChunks = chunks;
      docSources = buildDocSources(chunks);
    }
  }

  let chatResult;
  try {
    chatResult = await postChat({
      message,
      retrieved_data,
      doc_chunks: docChunks,
      conversation_history: Array.isArray(conversationHistory) ? conversationHistory.slice(-12) : [],
    });
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
    data: {
      reply: chatResult.reply,
      sources: [...sources, ...docSources],
      disclaimer: chatResult.disclaimer,
      sessionId: sessionId || null,
    },
  });
});

module.exports = { postAssistantChat };
