import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'
import './maple-mono.css'
import { getLang } from '@shared/i18n'
import { primeCjkFont } from './lib/appearance'
import { installCaretAutoScroll } from './lib/caret'

document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en'
// 所有输入框统一：光标跑到可视区外时把输入框滚过去
installCaretAutoScroll()

if (!import.meta.env.VITE_DEMO) {
  // 中文字体按设置要用到思源黑体时才下载（默认走系统字体）
  primeCjkFont()
  void import('./fonts.css')
} else {
  // 在线演示版不打包字体文件，改从 Google Fonts 加载
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href =
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&family=Noto+Serif+SC:wght@600&family=JetBrains+Mono:wght@400;500&display=swap'
  document.head.appendChild(link)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
