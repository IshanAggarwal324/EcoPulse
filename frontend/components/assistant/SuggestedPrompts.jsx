import React from 'react';

const DEFAULT_PROMPTS = [
  'What is the total grid energy generated?',
  'How much energy was consumed this week?',
  'Show me the grid trading volume',
];

const SuggestedPrompts = ({ prompts, onSelect }) => {
  const items = prompts || DEFAULT_PROMPTS;

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {items.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onSelect?.(prompt)}
          className="px-3 py-1.5 text-xs rounded-lg border border-slate-700/50 bg-slate-800/50 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/30 hover:bg-emerald-500/5 transition-colors"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
};

export default React.memo(SuggestedPrompts);
