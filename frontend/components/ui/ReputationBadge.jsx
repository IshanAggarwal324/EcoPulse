import React from 'react';
import { Star } from 'lucide-react';

const roundHalf = (n) => Math.round((Number(n) || 0) * 2) / 2;

const Stars = ({ value = 0, size = 12 }) => {
  const rounded = roundHalf(value);
  return (
    <div className="flex items-center" aria-label={`${rounded} out of 5 stars`} role="img">
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = rounded >= i ? 1 : rounded >= i - 0.5 ? 0.5 : 0;
        return (
          <span key={i} className="relative inline-block" style={{ width: size, height: size }}>
            <Star size={size} className="absolute inset-0 text-slate-600" />
            <span
              className="absolute inset-0 overflow-hidden"
              style={{ width: `${fill * 100}%` }}
            >
              <Star size={size} className="text-amber-400 fill-amber-400" />
            </span>
          </span>
        );
      })}
    </div>
  );
};

const ReputationBadge = ({ reputation }) => {
  const count = Number(reputation?.ratingCount) || 0;
  if (!count) {
    return (
      <span className="text-xs px-2 py-1 bg-slate-700/30 text-slate-500 rounded-lg border border-slate-700/20">
        Unrated
      </span>
    );
  }
  const avg = Number(reputation.avgScore) || 0;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-amber-500/10 text-amber-300 rounded-lg border border-amber-500/20"
      title={`${avg.toFixed(1)} avg from ${count} rating${count === 1 ? '' : 's'}`}
    >
      <span className="font-semibold">{avg.toFixed(1)}</span>
      <Stars value={avg} />
      <span className="text-amber-400/70">({count})</span>
    </span>
  );
};

export default ReputationBadge;
