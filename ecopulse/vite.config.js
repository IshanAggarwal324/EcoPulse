import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dep = (name) => path.resolve(__dirname, 'node_modules', name)

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  optimizeDeps: {
    // victory-vendor has no "." export (only d3-* subpaths) — do not include it here.
    include: ['recharts', 'react-is', 'react-redux', 'immer', 'leaflet', 'react-leaflet'],
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom', 'react-is'],
    alias: {
      react: dep('react'),
      'react-dom': dep('react-dom'),
      'react-router-dom': dep('react-router-dom'),
      'lucide-react': dep('lucide-react'),
      ethers: dep('ethers'),
      recharts: dep('recharts/es6/index.js'),
      'socket.io-client': dep('socket.io-client/build/esm/index.js'),
      // Module 9.5 — frontend sources live outside the project root, so bare
      // specifiers resolve via node walk-up that misses ecopulse/node_modules.
      // Alias explicitly like the other deps.
      leaflet: dep('leaflet'),
      'react-leaflet': dep('react-leaflet'),
      '@react-leaflet/core': dep('@react-leaflet/core'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          ethers: ['ethers'],
          recharts: ['recharts'],
          socket: ['socket.io-client'],
          leaflet: ['leaflet', 'react-leaflet'],
        },
      },
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  esbuild: {
    supported: {
      destructuring: true,
    },
  },
})
