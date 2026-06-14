const { postChat, fetchDocChunks, GenaiServiceError } = require('../services/genaiClient');
const { classifyIntent } = require('../services/intentClassifier');
const { retrieveForIntent } = require('../services/retrievalService');
const asyncHandler = require('../utils/asyncHandler');

const DOC_CHUNK_INTENTS = new Set(['general', 'faq']);
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CONTENT_CHARS = 800;
const MAX_DOC_CHUNKS = 4;

const normalizeText = (value, maxChars) =>
  String(value || '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxChars);

const sanitizeConversationHistory = (history) => {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn?.role === 'assistant' ? 'assistant' : 'user',
    content: normalizeText(turn?.content, MAX_HISTORY_CONTENT_CHARS),
  })).filter((turn) => turn.content.length > 0);
};

const sanitizeDocChunks = (chunks) => {
  if (!Array.isArray(chunks)) return null;
  return chunks.slice(0, MAX_DOC_CHUNKS).map((chunk) => ({
    docId: normalizeText(chunk?.docId, 120),
    title: normalizeText(chunk?.title, 160),
    excerpt: normalizeText(chunk?.excerpt, 800),
  })).filter((chunk) => chunk.excerpt.length > 0);
};

const sanitizeRetrievedData = (data) => {
  if (!data || typeof data !== 'object') return null;
  try {
    const raw = JSON.stringify(data);
    if (raw.length <= 8000) return data;
    return {
      _truncated: true,
      payload: raw.slice(0, 8000),
    };
  } catch {
    return null;
  }
};

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
  const safeMessage = normalizeText(message, MAX_MESSAGE_CHARS);
  if (!safeMessage) {
    return res.status(400).json({
      success: false,
      message: 'Message is required',
    });
  }

  const walletAddress = req.user?.walletAddress || null;

  const { intent, period } = classifyIntent(safeMessage);
  const { retrieved_data, sources } = await retrieveForIntent(intent, { walletAddress, period });

  let docChunks = null;
  let docSources = [];
  if (DOC_CHUNK_INTENTS.has(intent)) {
    const chunks = await fetchDocChunks(safeMessage);
    if (chunks.length > 0) {
      docChunks = sanitizeDocChunks(chunks);
      docSources = buildDocSources(chunks);
    }
  }

  const safeHistory = sanitizeConversationHistory(conversationHistory);

  let chatResult;
  try {
    chatResult = await postChat({
      message: safeMessage,
      retrieved_data: sanitizeRetrievedData(retrieved_data),
      doc_chunks: docChunks,
      conversation_history: safeHistory,
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
