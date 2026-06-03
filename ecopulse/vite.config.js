import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dep = (name) => path.resolve(__dirname, 'node_modules', name)

// https://vite.dev/config/
export default defineConfig({
  build: {
    minify: false
  },
  plugins: [
    tailwindcss(),
    react()
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom'],
    alias: {
      react: dep('react'),
      'react-dom': dep('react-dom'),
      'react-router-dom': dep('react-router-dom'),
      'lucide-react': dep('lucide-react'),
      ethers: dep('ethers'),
      // ESM entry avoids broken default export when aliasing the package root (Rolldown prod bug).
      'socket.io-client': dep('socket.io-client/build/esm/index.js'),
    },
  },
})
