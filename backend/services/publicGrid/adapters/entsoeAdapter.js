const { coerceMw, normalizeReading, buildExternalReadingId } = require('./baseAdapter');

/**
 * ENTSO-E adapter — European transparency platform.
 * Rich data across European bidding zones. Requires a free security token
 * `ENTSOE_API_TOKEN` (request via transparency@entsoe.eu).
 *
 * Contract (XML responses — no JSON):
 *   GET https://transparency.entsoe.eu/api
 *     query: securityToken, documentType, in_Domain, periodStart, periodEnd
 *
 *   Actual total generation : documentType=A73, in_Domain={zone}
 *   Actual total load       : documentType=A65, in_Domain={zone}
 *
 * Dates are `YYYYMMDDHHMM`. We parse only the well-known `<Point>` /
 * `<quantity>` / `<timeInterval>` structure with a focused extractor (no XML
 * dependency). Zone is configurable; default is the German bidding zone.
 *
 * Field mapping (1.5.4): MW.
 */

const HOSTS = ['transparency.entsoe.eu'];
const BASE = 'https://transparency.entsoe.eu/api';
const DEFAULT_ZONE = '10Y1001A1001A83F'; // 50Hertz + Amprion + TenneT + TransnetBW (DE)
const DOC_GENERATION = 'A73';
const DOC_LOAD = 'A65';
const WINDOW_HOURS = 6;

const validateConfig = (config) => {
  const errors = [];
  const cfg = config && typeof config === 'object' ? config : {};

  const zone =
    typeof cfg.zone === 'string' && /^[0-9A-Z-]{10,32}$/.test(cfg.zone) ? cfg.zone : DEFAULT_ZONE;

  return { ok: true, normalized: { zone }, errors };
};

const entsoeTime = (date) =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate(),
  ).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}00`;

const parseIsoPeriod = (resolution) => {
  // "PT60M" -> 60*60*1000 ; "PT15M" -> 15*60*1000 ; "PT1H" -> 3600000
  const m = String(resolution || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return 3600 * 1000;
  const hours = parseInt(m[1], 10) || 0;
  const minutes = parseInt(m[2], 10) || 0;
  return (hours * 3600 + minutes * 60) * 1000 || 3600 * 1000;
};

/**
 * Extract the most-recent { quantity, timestamp } from an ENTSO-E time-series
 * document. Defensive: tolerates missing/empty values and returns null when no
 * Point has a numeric quantity.
 */
const extractLatestPoint = (xml) => {
  if (typeof xml !== 'string' || xml.length === 0) return null;

  // Reject error documents early (ENTSO-E returns <text>...</text> orAcknowledgement).
  if (/<error/i.test(xml) || /Acknowledge_MarketDocument/i.test(xml)) {
    const msg = xml.match(/<text>([^<]*)<\/text>/i);
    throw new Error(`ENTSO-E error: ${(msg && msg[1]) || 'unspecified'}`.slice(0, 200));
  }

  const startMatch = xml.match(/<start>([^<]+)<\/start>/i);
  const startMs = startMatch ? Date.parse(startMatch[1]) : NaN;
  const resMatch = xml.match(/<resolution>([^<]+)<\/resolution>/i);
  const stepMs = parseIsoPeriod(resMatch?.[1]);

  // Capture every Point block; take the last with a numeric quantity.
  const pointRegex = /<Point>\s*<position>(\d+)<\/position>\s*(?:<quantity>([^<]*)<\/quantity>)?/gi;
  let last = null;
  let m;
  while ((m = pointRegex.exec(xml)) !== null) {
    const position = parseInt(m[1], 10);
    const mw = coerceMw(m[2]);
    if (mw !== null) last = { position, mw };
  }
  if (!last) return null;

  let timestamp = new Date();
  if (Number.isFinite(startMs)) {
    timestamp = new Date(startMs + (last.position - 1) * stepMs);
  }
  return { value: last.mw, timestamp };
};

const fetchDocument = async ({ documentType, zone, fetch, apiKey }) => {
  if (!apiKey) throw new Error('ENTSO-E requires a security token (ENTSOE_API_TOKEN)');
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_HOURS * 3600 * 1000);
  const params = new URLSearchParams({
    securityToken: apiKey,
    documentType,
    in_Domain: zone,
    out_Domain: zone,
    periodStart: entsoeTime(start),
    periodEnd: entsoeTime(end),
  });
  const res = await fetch(`${BASE}?${params.toString()}`);
  if (!res.ok) {
    const detail = res.status === 401 ? ' (invalid/missing token)' : '';
    throw new Error(`ENTSO-E HTTP ${res.status} for ${documentType}${detail}`);
  }
  const xml = await res.text();
  return extractLatestPoint(xml);
};

const fetchLatest = async ({ config, apiKey, fetch }) => {
  const { zone } = validateConfig(config).normalized;

  const [gen, load] = await Promise.all([
    fetchDocument({ documentType: DOC_GENERATION, zone, fetch, apiKey }).catch((e) => {
      throw e;
    }),
    fetchDocument({ documentType: DOC_LOAD, zone, fetch, apiKey }).catch(() => null),
  ]);

  if (!gen && !load) throw new Error('ENTSO-E returned no usable data');

  const timestamp = (gen?.timestamp && load?.timestamp && gen.timestamp > load.timestamp
    ? gen.timestamp
    : load?.timestamp || gen?.timestamp);

  const normalized = normalizeReading({
    energyGenerated: gen?.value ?? null,
    energyConsumed: load?.value ?? null,
    timestamp,
    externalReadingId: buildExternalReadingId(
      'entsoe',
      zone,
      DOC_GENERATION,
      timestamp.toISOString(),
    ),
    unit: 'MW',
  });
  if (!normalized.ok) throw new Error(`ENTSO-E normalize failed: ${normalized.message}`);

  return { readings: [normalized.reading], sourceTimestamp: timestamp };
};

module.exports = {
  providerKey: 'entsoe_eu',
  displayName: 'Europe — ENTSO-E Transparency',
  attribution: 'Data: ENTSO-E Transparency Platform',
  hosts: HOSTS,
  requiresApiKey: true,
  apiKeyEnvVar: 'ENTSOE_API_TOKEN',
  validateConfig,
  fetchLatest,
  extractLatestPoint,
  DEFAULT_ZONE,
};
