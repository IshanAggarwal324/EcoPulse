/** Capacity and diurnal curves (kW) by node profile. */

const CAPACITY_KW = {
  solar: { generate: 48, consume: 2 },
  wind: { generate: 55, consume: 3 },
  home: { generate: 4, consume: 28 },
  industry: { generate: 12, consume: 85 },
  other: { generate: 20, consume: 20 },
};

const clamp = (min, max, value) => Math.min(max, Math.max(min, value));

/** Gaussian-ish solar curve: 0 at night, peak near solar noon. */
const solarIrradiance = (hour) => {
  if (hour < 5 || hour >= 21) return 0;
  const peakHour = 13;
  const width = 3.2;
  const x = (hour - peakHour) / width;
  return Math.exp(-0.5 * x * x);
};

/** Wind: moderate baseline with diurnal shift and pseudo-gusts from time seed. */
const windAvailability = (hour, minute, nodeSeed = 0) => {
  const t = hour + minute / 60;
  const diurnal = 0.12 * Math.sin(((t - 4) * Math.PI) / 12);
  const gust = 0.18 * Math.sin(t * 0.9 + nodeSeed * 1.7);
  const turbulence = 0.08 * Math.sin(t * 2.3 + nodeSeed);
  return clamp(0.08, 1, 0.55 + diurnal + gust + turbulence);
};

/** Residential load: morning and evening peaks. */
const homeLoadFactor = (hour) => {
  const morning = Math.exp(-0.5 * ((hour - 8) / 1.8) ** 2);
  const evening = Math.exp(-0.5 * ((hour - 19) / 2.2) ** 2);
  const base = 0.22;
  return clamp(0.1, 1, base + morning * 0.55 + evening * 0.65);
};

/** Industrial: weekday daytime, lower on weekends. */
const industryLoadFactor = (hour, dayOfWeek) => {
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (hour < 6 || hour >= 22) return isWeekend ? 0.08 : 0.12;
  const workday = Math.exp(-0.5 * ((hour - 14) / 4) ** 2);
  const scale = isWeekend ? 0.35 : 1;
  return clamp(0.1, 1, (0.35 + workday * 0.55) * scale);
};

const cloudCoverNoise = (nodeSeed, hour) => {
  const slow = Math.sin(hour * 0.4 + nodeSeed * 2.1) * 0.12;
  const fast = (Math.random() - 0.5) * 0.08;
  return clamp(0.7, 1.05, 1 + slow + fast);
};

const hashSeed = (str) => {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 10000;
  }
  return h / 10000;
};

const resolveBaseCapacity = (sourceType, overrides) => {
  if (overrides && overrides[sourceType]) {
    return {
      generate: overrides[sourceType].capacityGenerateKw,
      consume: overrides[sourceType].capacityConsumeKw,
    };
  }
  return CAPACITY_KW[sourceType] || CAPACITY_KW.other;
};

const getCapacity = (sourceType, nodeType, overrides) => {
  const base = resolveBaseCapacity(sourceType, overrides);
  if (nodeType === 'consumer') {
    return { generate: base.generate * 0.15, consume: base.consume };
  }
  if (nodeType === 'producer') {
    return { generate: base.generate, consume: base.consume * 0.2 };
  }
  return base;
};

/**
 * Target kW before smoothing (not yet noised).
 * @param {object} node - { nodeType, sourceType, status, _id|nodeId }
 * @param {Date} at
 * @param {object} [options]
 * @param {object} [options.capacityOverrides] - DB-backed capacity overrides keyed by sourceType
 */
const computeTargets = (node, at = new Date(), options = {}) => {
  const hour = at.getHours();
  const minute = at.getMinutes();
  const dayOfWeek = at.getDay();
  const sourceType = node.sourceType || 'other';
  const nodeType = node.nodeType || 'producer';
  const seed = hashSeed(node._id || node.nodeId || node.name || 'node');
  const capacity = getCapacity(sourceType, nodeType, options.capacityOverrides);

  if (node.status === 'inactive') {
    return { energyGenerated: 0, energyConsumed: 0 };
  }

  if (node.status === 'maintenance') {
    return {
      energyGenerated: capacity.generate * 0.02,
      energyConsumed: capacity.consume * 0.15,
    };
  }

  let genTarget = 0;
  let conTarget = 0;

  switch (sourceType) {
    case 'solar':
      genTarget = capacity.generate * solarIrradiance(hour) * cloudCoverNoise(seed, hour);
      conTarget = capacity.consume * (0.3 + homeLoadFactor(hour) * 0.2);
      break;
    case 'wind':
      genTarget = capacity.generate * windAvailability(hour, minute, seed);
      conTarget = capacity.consume * (0.25 + homeLoadFactor(hour) * 0.15);
      break;
    case 'home':
      genTarget = capacity.generate * solarIrradiance(hour) * 0.35;
      conTarget = capacity.consume * homeLoadFactor(hour);
      break;
    case 'industry':
      genTarget = capacity.generate * solarIrradiance(hour) * 0.2;
      conTarget = capacity.consume * industryLoadFactor(hour, dayOfWeek);
      break;
    default:
      genTarget = capacity.generate * 0.4 * (solarIrradiance(hour) + windAvailability(hour, minute, seed)) / 2;
      conTarget = capacity.consume * homeLoadFactor(hour);
  }

  if (nodeType === 'consumer') {
    genTarget *= 0.1;
  } else if (nodeType === 'producer') {
    conTarget *= 0.25;
  }

  return {
    energyGenerated: Math.max(0, genTarget),
    energyConsumed: Math.max(0, conTarget),
  };
};

/**
 * Hourly normalised factor (0..~1) for a source type — used to render an
 * accurate schedule preview in the admin UI without duplicating curve math.
 */
const previewFactors = (sourceType) => {
  const out = [];
  for (let hour = 0; hour < 24; hour += 1) {
    let factor = 0;
    switch (sourceType) {
      case 'solar':
        factor = solarIrradiance(hour) * cloudCoverNoise(0, hour);
        break;
      case 'wind':
        factor = windAvailability(hour, 0, 0);
        break;
      case 'home':
        factor = homeLoadFactor(hour);
        break;
      case 'industry':
        factor = industryLoadFactor(hour, 1);
        break;
      default:
        factor = (solarIrradiance(hour) + windAvailability(hour, 0, 0)) / 2;
    }
    out.push({ hour, factor: Math.round(Math.max(0, factor) * 1000) / 1000 });
  }
  return out;
};

module.exports = {
  CAPACITY_KW,
  SOURCE_TYPES: ['solar', 'wind', 'home', 'industry', 'other'],
  computeTargets,
  getCapacity,
  resolveBaseCapacity,
  hashSeed,
  previewFactors,
};
