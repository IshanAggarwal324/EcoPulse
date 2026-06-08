const PERIOD_MAP = {
  '7d': { hours: 168, label: 'Last 7 days' },
  '14d': { hours: 336, label: 'Last 14 days' },
  '30d': { hours: 720, label: 'Last 30 days' },
};

const VALID_PERIODS = Object.keys(PERIOD_MAP);

function resolveSinceDate(sinceHours) {
  const date = new Date();
  date.setTime(date.getTime() - sinceHours * 60 * 60 * 1000);
  return date;
}

function parsePeriod(period) {
  const entry = PERIOD_MAP[period];
  if (!entry) return null;
  return {
    sinceHours: entry.hours,
    sinceDate: resolveSinceDate(entry.hours),
    label: entry.label,
  };
}

module.exports = { parsePeriod, resolveSinceDate, VALID_PERIODS, PERIOD_MAP };
