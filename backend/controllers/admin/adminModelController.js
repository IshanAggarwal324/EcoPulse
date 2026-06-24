/**
 * Admin Model lifecycle controller (Module 4.2.7).
 *
 * Thin proxy to the AI service /models surface. User authorization (admin role)
 * is enforced by the mounted admin route; this controller only adds the
 * service-to-service internal API key and forwards the request.
 */
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/apiError');
const { getAiServiceUrl } = require('../../config/serviceUrls');
const { fetchWithTimeout } = require('../../utils/fetchWithTimeout');

const AI_SERVICE_URL = getAiServiceUrl();
const INTERNAL_SERVICE_API_KEY = process.env.INTERNAL_SERVICE_API_KEY || '';
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !INTERNAL_SERVICE_API_KEY) {
  throw new Error('INTERNAL_SERVICE_API_KEY must be set in production');
}

const VERSION_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

const buildInternalHeaders = () => ({
  'Content-Type': 'application/json',
  ...(INTERNAL_SERVICE_API_KEY ? { 'x-internal-api-key': INTERNAL_SERVICE_API_KEY } : {}),
});

const safeUpstreamErrorDetails = async (response) => {
  if (isProduction) return undefined;
  const text = await response.text();
  return text.slice(0, 500);
};

const assertVersionParam = (value) => {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('version is required', 400, 'INVALID_MODEL_VERSION');
  }
  if (!VERSION_PARAM_RE.test(String(value))) {
    throw new ApiError(
      'version must be alphanumeric, underscore or hyphen (max 64 chars)',
      400,
      'INVALID_MODEL_VERSION',
    );
  }
  return String(value);
};

async function callAiModels(path, { method = 'GET', body } = {}) {
  const response = await fetchWithTimeout(`${AI_SERVICE_URL}/models${path}`, {
    method,
    headers: buildInternalHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}

const handleUpstream = async (response) => {
  if (!response.ok) {
    const details = await safeUpstreamErrorDetails(response);
    throw new ApiError(
      'Error communicating with AI service',
      response.status,
      'AI_UPSTREAM_ERROR',
      details,
    );
  }
  return response.json();
};

const listModelVersions = asyncHandler(async (req, res) => {
  let response;
  try {
    response = await callAiModels('/versions');
  } catch (error) {
    throw new ApiError('AI service unavailable', 503, 'AI_UNAVAILABLE');
  }
  const data = await handleUpstream(response);
  return res.status(200).json({ success: true, data });
});

const compareModels = asyncHandler(async (req, res) => {
  const versionA = assertVersionParam(req.query.versionA);
  const versionB = assertVersionParam(req.query.versionB);
  const nodeId = req.query.nodeId;
  const qs = new URLSearchParams({ versionA, versionB });
  if (nodeId !== undefined && nodeId !== null && nodeId !== '') {
    qs.set('nodeId', String(nodeId).slice(0, 128));
  }

  let response;
  try {
    response = await callAiModels(`/compare?${qs.toString()}`);
  } catch (error) {
    throw new ApiError('AI service unavailable', 503, 'AI_UNAVAILABLE');
  }
  const data = await handleUpstream(response);
  return res.status(200).json({ success: true, data });
});

const promoteModel = asyncHandler(async (req, res) => {
  const version = assertVersionParam(req.body && req.body.version);
  let response;
  try {
    response = await callAiModels('/promote', { method: 'POST', body: { version } });
  } catch (error) {
    throw new ApiError('AI service unavailable', 503, 'AI_UNAVAILABLE');
  }
  const data = await handleUpstream(response);
  return res.status(200).json({ success: true, data });
});

const getDriftStatus = asyncHandler(async (req, res) => {
  let response;
  try {
    response = await callAiModels('/drift');
  } catch (error) {
    throw new ApiError('AI service unavailable', 503, 'AI_UNAVAILABLE');
  }
  const data = await handleUpstream(response);
  return res.status(200).json({ success: true, data });
});

module.exports = {
  listModelVersions,
  compareModels,
  promoteModel,
  getDriftStatus,
};
