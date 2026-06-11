import React from 'react';
import { Bot, User } from 'lucide-react';
import SourceChips from './SourceChips';

const ChatMessage = ({ role, content, disclaimer, sources, highlights }) => {
  const isUser = role === 'user';

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isUser
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'bg-slate-700/60 text-slate-300'
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      <div className={`flex flex-col max-w-[80%] min-w-0 ${isUser ? 'items-end' : ''}`}>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isUser
              ? 'bg-emerald-500/15 text-emerald-50 border border-emerald-500/20 rounded-br-md'
              : 'bg-slate-800/80 text-slate-200 border border-slate-700/40 rounded-bl-md'
          }`}
        >
          {content}

          {highlights?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {highlights.map((h, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-slate-300">
                  <span className="text-emerald-400 mt-0.5">&#x2022;</span>
                  {h}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!isUser && <SourceChips sources={sources} />}

        {disclaimer && !isUser && (
          <p className="text-[10px] text-slate-500 mt-1 px-1">{disclaimer}</p>
        )}
      </div>
    </div>
  );
};

export default React.memo(ChatMessage);
