import React, { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, FileText, Loader2, Trash2 } from 'lucide-react';
import ChatMessage from './ChatMessage';
import ReportWizardModal from './ReportWizardModal';
import useAssistantChat from '../../hooks/useAssistantChat';

const SUGGESTED_PROMPTS = [
  'What is the total grid energy generated?',
  'How much energy was consumed this week?',
  'Show me the grid trading volume',
];

const AssistantChat = () => {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const { messages, isLoading, sendMessage, generateReport, clearMessages } = useAssistantChat();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input);
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReportConfirm = (opts) => {
    setWizardOpen(false);
    generateReport(opts);
  };

  const handleSuggestedPrompt = (prompt) => {
    sendMessage(prompt);
  };

  const isEmpty = messages.length === 0;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 shadow-lg shadow-emerald-500/10 hover:bg-emerald-500/30 hover:shadow-emerald-500/20 transition-all flex items-center justify-center"
          aria-label="Open assistant"
        >
          <MessageCircle size={22} />
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-50 flex flex-col w-[min(24rem,calc(100vw-2.5rem))] h-[min(32rem,calc(100dvh-3rem))] bg-slate-950 border border-slate-700/50 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/60 bg-slate-950/95 backdrop-blur-xl">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center">
                <MessageCircle size={14} className="text-white" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Energy Assistant</h3>
                <p className="text-[10px] text-slate-500">Powered by AI</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className="p-2 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                title="Generate Report"
              >
                <FileText size={16} />
              </button>
              <button
                type="button"
                onClick={clearMessages}
                className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                title="Clear chat"
              >
                <Trash2 size={16} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar">
            {isEmpty && (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                  <MessageCircle size={22} className="text-emerald-400" />
                </div>
                <p className="text-sm font-medium text-slate-300 mb-1">Ask me anything about your energy data</p>
                <p className="text-xs text-slate-500 mb-4">Grid stats, trading volume, carbon credits, and more</p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => handleSuggestedPrompt(prompt)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-slate-700/50 bg-slate-800/50 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/30 hover:bg-emerald-500/5 transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <ChatMessage
                key={i}
                role={msg.role}
                content={msg.content}
                disclaimer={msg.disclaimer}
                sources={msg.sources}
                highlights={msg.highlights}
              />
            ))}

            {isLoading && (
              <div className="flex gap-2.5">
                <div className="flex-shrink-0 w-7 h-7 rounded-full bg-slate-700/60 flex items-center justify-center">
                  <Loader2 size={14} className="text-slate-300 animate-spin" />
                </div>
                <div className="bg-slate-800/80 border border-slate-700/40 rounded-2xl rounded-bl-md px-3.5 py-2.5">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="px-3 py-2.5 border-t border-slate-800/60 bg-slate-950/95">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isLoading ? 'Waiting for response...' : 'Ask about your energy data...'}
                disabled={isLoading}
                className="flex-1 bg-slate-800/50 border border-slate-700/40 rounded-xl px-3.5 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 disabled:opacity-50 transition-colors"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="p-2 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      <ReportWizardModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConfirm={handleReportConfirm}
      />
    </>
  );
};

export default React.memo(AssistantChat);
