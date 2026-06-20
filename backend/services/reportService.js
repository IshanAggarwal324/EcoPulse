const EnergyReading = require('../models/EnergyReading');
const { getEnergyTotals } = require('./analytics/energyAnalytics');
const { getTradeStats, getPlatformVolumeByDay, getWalletFlowHistory } = require('./analytics/tradeAnalytics');
const { getNodeStats } = require('./analytics/nodeAnalytics');
const { getCarbonStats } = require('./analytics/carbonAnalytics');
const { parsePeriod } = require('../utils/periodHelpers');
const { retrieveForecast } = require('./retrievalService');

async function buildGridEnergySection(since) {
  const { totalGenerated, totalConsumed, readingCount } = await getEnergyTotals(since);

  return {
    totalGenerated,
    totalConsumed,
    netEnergy: totalGenerated - totalConsumed,
    readingCount,
  };
}

async function buildGridTradingSection(since) {
  const [stats, dailyVolume] = await Promise.all([
    getTradeStats(),
    getPlatformVolumeByDay(since),
  ]);

  return {
    completedTrades: stats.completedTrades,
    totalEnergyTraded: stats.totalEnergyTraded,
    totalVolumeCredits: stats.totalVolumeCredits,
    totalListings: stats.totalListings,
    cancelledListings: stats.cancelledListings,
    dailyVolume,
  };
}

async function buildNodeOverviewSection() {
  const { activeNodes, totalNodes, byStatus } = await getNodeStats();

  return {
    activeNodes,
    totalNodes,
    byStatus,
  };
}

async function buildPersonalProfitSection(walletAddress, since) {
  if (!walletAddress) return null;

  const {
    creditsReceived,
    creditsSpent,
    netFlow,
    saleCount,
    purchaseCount,
    history,
  } = await getWalletFlowHistory(walletAddress, since);

  return {
    creditsReceived,
    creditsSpent,
    netFlow,
    saleCount,
    purchaseCount,
    dailyHistory: history,
  };
}

async function buildCarbonSection(walletAddress) {
  if (!walletAddress) return null;

  const {
    totalCreditsTraded,
    completedTrades,
    walletBalance,
    estimatedGridCredits,
    balanceAnalytics,
  } = await getCarbonStats(walletAddress);

  return {
    totalCreditsTraded,
    completedTrades,
    walletBalance,
    estimatedGridCredits,
    walletNetFlow: balanceAnalytics?.wallet?.netFlow ?? null,
  };
}

async function buildReportMeta({ period, scope, walletAddress }) {
  const readingCount = await EnergyReading.countDocuments();
  const isDemoData = readingCount < 30 && process.env.NODE_ENV !== 'production';

  const walletConnected = !!walletAddress;
  const walletWarning = !walletConnected
    ? 'No wallet connected. Personal profit and carbon sections are omitted. Connect a wallet to see personal data.'
    : null;

  return {
    isDemoData,
    period,
    scope,
    generatedAt: new Date().toISOString(),
    walletConnected,
    walletWarning,
  };
}

// Sub-module 3.4.4 — populate the forecastOutlook section consumed by the PDF
// report (templates/reportTemplate.js renderForecastSection). Was previously
// scaffold-only: the PDF renderer existed but buildReportMetrics never produced
// the data, so the section was silently skipped.
function _toForecastRow(pred) {
  if (!pred || typeof pred !== 'object') return null;
  const date = pred.timestamp ?? pred.date ?? pred.ds ?? null;
  const predicted = Number(pred.predicted_generation ?? pred.generation ?? pred.predicted ?? pred.value);
  if (!Number.isFinite(predicted)) return null;
  return { date, predicted: Math.round(predicted * 10) / 10 };
}

function mapForecastPredictions(predictions) {
  if (!Array.isArray(predictions)) return [];
  return predictions.map(_toForecastRow).filter(Boolean);
}

async function buildForecastOutlookSection() {
  let result;
  try {
    result = await retrieveForecast({});
  } catch (_) {
    return null; // forecast service down → omit section (PDF handles absence)
  }

  const data = result?.retrieved_data;
  const forecast = data?.forecast;
  if (!data?.available || !forecast) return null;

  const rows = mapForecastPredictions(forecast.predictions);
  if (rows.length === 0) return null;

  const total = rows.reduce((acc, r) => acc + r.predicted, 0);
  const horizon = forecast.daysToPredict || 7;

  return {
    summary: `Projected ~${Math.round(total)} kWh of generation over the next ${horizon} days.`,
    forecasts: rows,
    disclaimer: forecast.modelStatus
      ? `Forecast model: ${forecast.modelStatus}.`
      : 'Based on forecast model output.',
  };
}

function filterByScope(metrics, scope) {
  const result = { ...metrics };

  if (scope === 'grid') {
    delete result.personalEnergy;
    delete result.personalProfit;
    delete result.carbon;
  } else if (scope === 'personal') {
    delete result.gridEnergy;
    delete result.gridTrading;
    delete result.nodeOverview;
  }

  return result;
}

function truncateDailyVolume(rows, maxDays = 30) {
  if (!Array.isArray(rows)) return rows;
  if (rows.length <= maxDays) return rows;
  return rows.slice(rows.length - maxDays);
}

async function buildReportMetrics({ period, walletAddress, scope = 'both' }) {
  const parsed = parsePeriod(period);
  if (!parsed) throw new Error(`Invalid period: ${period}`);

  const { sinceDate, label } = parsed;

  const [gridEnergy, gridTrading, nodeOverview, personalProfit, carbon, forecastOutlook, meta] = await Promise.all([
    buildGridEnergySection(sinceDate),
    buildGridTradingSection(sinceDate),
    buildNodeOverviewSection(),
    buildPersonalProfitSection(walletAddress, sinceDate),
    buildCarbonSection(walletAddress),
    buildForecastOutlookSection(),
    buildReportMeta({ period, scope, walletAddress }),
  ]);

  if (gridTrading.dailyVolume) {
    gridTrading.dailyVolume = truncateDailyVolume(gridTrading.dailyVolume);
  }
  if (personalProfit?.dailyHistory) {
    personalProfit.dailyHistory = truncateDailyVolume(personalProfit.dailyHistory);
  }

  const metrics = filterByScope({
    gridEnergy,
    gridTrading,
    nodeOverview,
    personalProfit,
    carbon,
    forecastOutlook,
    periodLabel: label,
  }, scope);

  return { ...metrics, meta };
}

module.exports = {
  buildGridEnergySection,
  buildGridTradingSection,
  buildNodeOverviewSection,
  buildPersonalProfitSection,
  buildCarbonSection,
  buildForecastOutlookSection,
  mapForecastPredictions,
  buildReportMeta,
  filterByScope,
  truncateDailyVolume,
  buildReportMetrics,
};
