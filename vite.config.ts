import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig(({ mode }) => {
  // `vite build --mode demo`：后端在浏览器里模拟，打成单个 JS + CSS，便于做成在线演示页
  const demo = mode === 'demo'
  return {
    root: 'web',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': r('./web/src'), '@shared': r('./shared') },
    },
    define: demo ? { 'import.meta.env.VITE_DEMO': JSON.stringify('1') } : {},
    server: {
      port: 5173,
      proxy: { '/api': 'http://localhost:8787' },
    },
    build: demo
      ? {
          outDir: '../dist-demo',
          emptyOutDir: true,
          cssCodeSplit: false,
          assetsInlineLimit: 100_000_000,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : { outDir: '../dist', emptyOutDir: true },
  }
})
