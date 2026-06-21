/**
 * Centralized client-side error reporting (L2).
 * Dev: full detail to console. Prod: scoped messages only; hooks can forward to APM later.
 */

const errorHandlers = [];

export function onClientError(handler) {
  if (typeof handler === 'function') {
    errorHandlers.push(handler);
  }
}

function notifyHandlers(payload) {
  for (const handler of errorHandlers) {
    try {
      handler(payload);
    } catch {
      // reporting must never throw
    }
  }
}

export function logClientError(scope, error, context = {}) {
  const message = error?.message || String(error);
  const payload = {
    scope,
    message,
    context,
    at: new Date().toISOString(),
  };

  if (import.meta.env.DEV) {
    console.error(`[${scope}]`, message, context, error);
  } else {
    console.error(`[${scope}]`, message);
  }

  notifyHandlers(payload);
}

export function logClientWarn(scope, message, context = {}) {
  if (import.meta.env.DEV) {
    console.warn(`[${scope}]`, message, context);
  }
}
