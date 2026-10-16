import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * @fontsource 的字体同时给了 woff2 和 woff，woff 只有很老的浏览器才用，却占了包里一半的体积（400 多个文件）。
 * 去掉 CSS 里的 woff 引用，构建时就不会再打进去
 */
const woff2Only = (): Plugin => ({
  name: 'woff2-only',
  apply: 'build',
  // CSS 里的 @import 在 Vite 内部展开，转换阶段看不到字体的 CSS，只能在出文件前改
  generateBundle(_, bundle) {
    for (const [name, f] of Object.entries(bundle)) {
      if (name.endsWith('.woff')) delete bundle[name]
      else if (f.type === 'asset' && name.endsWith('.css') && typeof f.source === 'string')
        f.source = f.source.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]?woff['"]?\)/g, '')
    }
  },
})

export default defineConfig(({ mode }) => {
  // `vite build --mode demo`：后端在浏览器里模拟，打成单个 JS + CSS，便于做成在线演示页
  const demo = mode === 'demo'
  return {
    root: 'web',
    plugins: [woff2Only(), react(), tailwindcss()],
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
