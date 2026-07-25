import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Scoped to frontend/**/__tests__/** per task 0 of the
// email-verification-banner-sync bugfix spec. This is a standalone Vitest
// project for the plain JS/JSX sources under frontend/ (which have no
// bundler of their own — the app is built by the Vite project in
// ../ecopulse). It does NOT touch the existing `npm test` (node --test)
// script, which continues to run hooks/__tests__/settlementSocket.test.js.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    include: ['**/__tests__/**/*.test.{js,jsx}'],
    // hooks/__tests__/settlementSocket.test.js is a node:test suite (run via
    // the existing `npm test` script), not a Vitest suite — exclude it here
    // so the two test runners stay independent.
    exclude: ['**/node_modules/**', 'hooks/__tests__/settlementSocket.test.js'],
    globals: true,
  },
});
