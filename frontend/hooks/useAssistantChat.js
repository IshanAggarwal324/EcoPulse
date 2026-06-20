import { useState, useCallback, useRef } from 'react';
import { assistantApi } from '../utils/api';
import { useToast } from '../context/ToastContext';

const MAX_HISTORY_TURNS = 6;

export default function useAssistantChat() {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const sessionIdRef = useRef(crypto.randomUUID?.() || Date.now().toString(36));
  const { error: showError, success: showSuccess } = useToast();

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
    async (text, context = {}) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;

      addMessage({ role: 'user', content: trimmed });
      setIsLoading(true);

      try {
        const res = await assistantApi.chat(
          trimmed,
          sessionIdRef.current,
          getHistory(),
          context,
        );
        const data = res.data || res;

        addMessage({
          role: 'assistant',
          content: data.reply || data.message || 'No response received.',
          sources: data.sources || [],
          disclaimer: data.disclaimer || null,
        });
      } catch (err) {
        let msg;
        if (err.status === 429) {
          msg = 'Too many messages. Please wait a moment and try again.';
        } else if (err.status === 503 || err.code === 'NETWORK_ERROR') {
          msg = 'The assistant service is currently unavailable. Your message was not sent. Please try again in a few seconds.';
        } else {
          msg = err.message || 'Something went wrong. Please try again.';
        }

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

        if (delivery === 'email' && data.status === 'queued') {
          showSuccess(data.message || 'Report sent to your email.');
          addMessage({
            role: 'assistant',
            content: data.message || 'Report sent to your email.',
            sources: [],
            disclaimer: null,
          });
        } else if (data.fallback === 'chat') {
          showError(data.message || 'Email delivery failed. Showing summary in chat.');
          addMessage({
            role: 'assistant',
            content: data.summary || 'Report generated (email delivery failed).',
            highlights: data.highlights || [],
            sources: data.sources || [],
            disclaimer: data.disclaimer || null,
            walletWarning: data.walletWarning || null,
          });
        } else {
          addMessage({
            role: 'assistant',
            content: data.summary || data.message || 'Report generated.',
            highlights: data.highlights || [],
            sources: data.sources || [],
            disclaimer: data.disclaimer || null,
            walletWarning: data.walletWarning || null,
          });
        }
      } catch (err) {
        let msg;
        if (err.status === 429) {
          msg = 'Too many report requests. Please wait before generating another.';
        } else if (err.status === 503 || err.code === 'NETWORK_ERROR') {
          msg = 'The report service is currently unavailable. Please try again shortly.';
        } else {
          msg = err.message || 'Failed to generate report.';
        }

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
    [isLoading, addMessage, showError, showSuccess],
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
