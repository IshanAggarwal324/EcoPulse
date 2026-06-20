const { postChat, fetchDocChunks, GenaiServiceError } = require('../services/genaiClient');
const { classifyIntent } = require('../services/intentClassifier');
const { retrieveForIntent } = require('../services/retrievalService');
const assistantMetrics = require('../services/assistantMetrics');
const assistantSession = require('../services/assistantSessionStore');
const asyncHandler = require('../utils/asyncHandler');

// Sub-module 3.1.5 — hybrid retrieval for all intents. Doc chunks are fetched
// for every question (not just faq/general) so the assistant always has access
// to curated knowledge alongside structured live data.
const DOC_CHUNK_TOP_K = 2;
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

// 3.3.3 — normalize + dedup source attribution so every chip has a stable
// type/label and no near-duplicates leak to the UI.
const MAX_SOURCES = 6;
function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  const out = [];
  const seen = new Set();
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const type = normalizeText(src.type, 20) || 'analytics';
    const label = normalizeText(src.label, 120) || type;
    const key = `${type}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { type, label };
    if (src.docId) entry.docId = normalizeText(src.docId, 120);
    out.push(entry);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

const postAssistantChat = asyncHandler(async (req, res) => {
  const { message, sessionId, conversationHistory, nodeId: bodyNodeId, pageContext } = req.body;
  const safeMessage = normalizeText(message, MAX_MESSAGE_CHARS);
  if (!safeMessage) {
    return res.status(400).json({
      success: false,
      message: 'Message is required',
    });
  }

  const walletAddress = req.user?.walletAddress || null;
  const userId = req.user?._id || null;

  const { intent, period, nodeId: detectedNodeId } = classifyIntent(safeMessage);
  // Prefer an explicit client-supplied nodeId, then a detected one. The
  // retrievers re-validate ownership, so this hint alone cannot leak data.
  const nodeId = bodyNodeId || detectedNodeId || null;

  const { retrieved_data, sources } = await retrieveForIntent(intent, {
    walletAddress,
    period,
    userId,
    nodeId,
    message: safeMessage,
  });

  let docChunks = null;
  let docSources = [];
  const chunks = await fetchDocChunks(safeMessage, DOC_CHUNK_TOP_K);
  if (chunks.length > 0) {
    docChunks = sanitizeDocChunks(chunks);
    docSources = buildDocSources(chunks);
  }

  // 3.3.1 — lightweight, PII-free caller context for the prompt. Never include
  // internal ids, wallet, or email here.
  const userContext = {};
  if (pageContext) userContext.pageContext = normalizeText(pageContext, 40);

  const safeHistory = sanitizeConversationHistory(conversationHistory);

  let chatResult;
  try {
    chatResult = await postChat({
      message: safeMessage,
      intent,
      retrieved_data: sanitizeRetrievedData(retrieved_data),
      doc_chunks: docChunks,
      user_context: Object.keys(userContext).length ? userContext : undefined,
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

  const finalSources = normalizeSources([...sources, ...docSources]);
  const sourceTypes = finalSources.map((s) => s.type);
  const docIds = docSources.map((s) => s.docId).filter(Boolean);

  // 3.4.1 / 3.4.2 — best-effort session snapshot + aggregated analytics.
  // Both are fire-and-forget: a Redis outage must never break the chat path,
  // and only metadata (intent/source-types/doc-ids) is persisted — never the
  // message, reply, or retrieved_data contents.
  assistantMetrics.recordChat({ intent, sourceTypes, docIds }).catch(() => {});
  if (sessionId) {
    assistantSession
      .saveSnapshot(sessionId, { intent, sourceTypes, docIds, period })
      .catch(() => {});
  }
  // 3.3 guardrail: log intent + source attribution only (never the prompt or
  // user message body) for debugging / analytics.
  console.info('[assistant] chat', {
    intent,
    sources: sourceTypes,
  });

  res.status(200).json({
    success: true,
    data: {
      reply: chatResult.reply,
      sources: finalSources,
      disclaimer: chatResult.disclaimer,
      sessionId: sessionId || null,
    },
  });
});

module.exports = { postAssistantChat, normalizeSources, buildDocSources };
