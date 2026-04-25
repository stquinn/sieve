import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const devBackend = `http://localhost:${process.env.SIEVE_DEV_PORT || '8081'}`

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': devBackend,
      '/sse': devBackend,
      '/static': devBackend,
      '/sieve': devBackend,
    },
  },
})
