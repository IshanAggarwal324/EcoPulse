import { useState, useCallback, useRef } from 'react';
import { assistantApi } from '../utils/api';
import { useToast } from '../context/ToastContext';

const MAX_HISTORY_TURNS = 6;

export default function useAssistantChat() {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef(crypto.randomUUID?.() || Date.now().toString(36));
  const { error: showError } = useToast();

  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const getHistory = useCallback(() => {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((m) => ({ role: m.role, content: m.content }));
  }, [messages]);

  const sendMessage = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;

      addMessage({ role: 'user', content: trimmed });
      setIsLoading(true);

      try {
        const res = await assistantApi.chat(
          trimmed,
          sessionIdRef.current,
          getHistory(),
        );
        const data = res.data || res;

        addMessage({
          role: 'assistant',
          content: data.reply || data.message || 'No response received.',
          sources: data.sources || [],
          disclaimer: data.disclaimer || null,
        });
      } catch (err) {
        const msg =
          err.status === 429
            ? 'Too many messages. Please wait a moment.'
            : err.status === 503
              ? 'Assistant is temporarily unavailable. Please try again.'
              : err.message || 'Failed to send message.';

        showError(msg);
        addMessage({
          role: 'assistant',
          content: msg,
          sources: [],
          disclaimer: null,
          isError: true,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, addMessage, getHistory, showError],
  );

  const generateReport = useCallback(
    async ({ period, scope, delivery }) => {
      if (isLoading) return;
      setIsLoading(true);

      try {
        const res = await assistantApi.generateReport({
          period,
          scope,
          delivery,
        });
        const data = res.data || res;

        addMessage({
          role: 'assistant',
          content: data.summary || data.message || 'Report generated.',
          highlights: data.highlights || [],
          sources: data.sources || [],
          disclaimer: data.disclaimer || null,
        });
      } catch (err) {
        const msg =
          err.status === 429
            ? 'Too many report requests. Please wait.'
            : err.status === 503
              ? 'Report service is temporarily unavailable.'
              : err.message || 'Failed to generate report.';

        showError(msg);
        addMessage({
          role: 'assistant',
          content: msg,
          sources: [],
          disclaimer: null,
          isError: true,
        });
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, addMessage, showError],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    sessionIdRef.current = crypto.randomUUID?.() || Date.now().toString(36);
  }, []);

  return {
    messages,
    isLoading,
    sendMessage,
    generateReport,
    clearMessages,
    sessionId: sessionIdRef.current,
  };
}
