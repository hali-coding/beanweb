import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { target: 'es2022' },
  server: {
    // Coffee Shop (src/lib/packages/coffeeshop.ts) fetches this path as
    // same-origin, the way it will once Apache reverse-proxies it in
    // production (coffeeshop/README.md). In dev there is no Apache, so this
    // proxy stands in for it: run the backend with `npm start` in
    // coffeeshop/ (defaults to :8080) and `npm run dev` here talks to it
    // without any source change.
    proxy: {
      '/api/coffeeshop': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
