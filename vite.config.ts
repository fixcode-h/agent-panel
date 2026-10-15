import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': r('./web/src'), '@shared': r('./shared') },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: '../dist', emptyOutDir: true },
})
