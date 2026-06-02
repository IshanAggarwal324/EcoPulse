import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react()
  ],
  resolve: {
  alias: {
    react: path.resolve(__dirname, './node_modules/react'),
    'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
    'react-router-dom': path.resolve(__dirname, './node_modules/react-router-dom'),
    'lucide-react': path.resolve(__dirname, './node_modules/lucide-react'),
    'socket.io-client': path.resolve(__dirname, './node_modules/socket.io-client'),
    ethers: path.resolve(__dirname, './node_modules/ethers'),
    recharts: path.resolve(__dirname, './node_modules/recharts'),
  },
},
})
