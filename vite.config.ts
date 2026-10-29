import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { writeDemoBuildInfo } from './scripts/lib/demo-build-info.mjs'
import { sourceLoc } from './scripts/lib/source-loc.mjs'
import { settingsIndex } from './scripts/lib/settings-index.mjs'

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

/**
 * demo 构建结束时在 dist-demo 里写一份源文件指纹，ui-check 启动时拿它判断产物是不是过期了
 * （见 scripts/lib/demo-build-info.mjs）。正式构建不写：dist/ 不用界面检查。
 */
const demoBuildInfo = (): Plugin => ({
  name: 'demo-build-info',
  apply: 'build',
  // closeBundle 在产物写完之后执行，此时 dist-demo 已经被清空重建过，标记不会被清掉
  closeBundle() {
    writeDemoBuildInfo(r('.'), r('./dist-demo'))
  },
})

export default defineConfig(({ mode }) => {
  // `vite build --mode demo`：后端在浏览器里模拟，打成单个 JS + CSS，便于做成在线演示页
  const demo = mode === 'demo'
  return {
    root: 'web',
    plugins: [
      woff2Only(),
      sourceLoc(r('./web/src')),
      settingsIndex(r('.')),
      react(),
      tailwindcss(),
      ...(demo ? [demoBuildInfo()] : []),
    ],
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
      : {
          outDir: '../dist',
          emptyOutDir: true,
          // 字体有 400 多个文件，和 js、css 堆在 assets/ 里很难翻；按类型分到子目录。
          // 文件名带哈希，按类型分不影响缓存；引用路径由 Vite 统一重写
          rollupOptions: {
            output: {
              entryFileNames: 'assets/js/[name]-[hash].js',
              chunkFileNames: 'assets/js/[name]-[hash].js',
              assetFileNames: (info) => {
                const name = info.names?.[0] ?? ''
                if (name.endsWith('.css')) return 'assets/css/[name]-[hash][extname]'
                if (/\.(woff2?|ttf|otf|eot)$/.test(name)) return 'assets/fonts/[name]-[hash][extname]'
                if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/.test(name)) return 'assets/img/[name]-[hash][extname]'
                return 'assets/[name]-[hash][extname]'
              },
            },
          },
        },
  }
})
