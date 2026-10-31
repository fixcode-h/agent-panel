import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { App } from './App'
import './index.css'
import './maple-mono.css'
import { getLang } from '@shared/i18n'
import { primeCjkFont } from './lib/appearance'
import { installCaretAutoScroll } from './lib/caret'

document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en'
// 所有输入框统一：光标跑到可视区外时把输入框滚过去
installCaretAutoScroll()

// 面板更新后，开着的旧标签页再打开懒加载的页面时，请求的是已经不存在的旧文件名，只会看到「页面出错」。
// 拦下这个错误刷新一次换上新版本；一分钟内只刷一次，新版本本身加载失败时不会无限刷新
window.addEventListener('vite:preloadError', (e) => {
  const KEY = 'agent-panel:preload-reload'
  let last = 0
  try {
    last = Number(sessionStorage.getItem(KEY)) || 0
  } catch {}
  if (Date.now() - last < 60_000) return
  e.preventDefault()
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {}
  location.reload()
})

if (!import.meta.env.VITE_DEMO) {
  // 中文字体按设置选的内置字体（默认思源黑体）先下载，选系统字体时不下载
  primeCjkFont()
  void import('./fonts.css')
} else {
  // 在线演示版不打包字体文件，改从 Google Fonts 加载
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href =
    'https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&family=Noto+Serif+SC:wght@600&family=JetBrains+Mono:wght@400;500&display=swap'
  document.head.appendChild(link)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 没写线宽的 lucide 图标默认 2.3（lucide 自带 2 偏细）；写了的各处已按同样比例加粗 */}
    <LucideProvider strokeWidth={2.3}>
      <App />
    </LucideProvider>
  </StrictMode>,
)
