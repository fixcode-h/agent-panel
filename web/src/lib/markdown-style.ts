import { markdownCss, type MarkdownStyle } from '@shared/markdown-style'
import { componentCss, type ComponentStyle } from '@shared/component-style'

const KEY = 'appearance-md'
const ID = 'md-style'

/**
 * 设置里改过的 Markdown 样式和组件微调（同一个机制，CSS 拼在一起）写进 head 里的一个 <style>：自定义颜色要按深浅色分两份（:root / :root.dark），
 * 挂在 html 的内联 style 上做不到；记进浏览器，index.html 加载时先套上，免得设置回来前闪一下默认样式
 */
export function applyMarkdownStyle(style: MarkdownStyle, components: ComponentStyle = {}) {
  const css = markdownCss(style) + componentCss(components)
  let el = document.getElementById(ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = ID
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
  try {
    if (css) localStorage.setItem(KEY, css)
    else localStorage.removeItem(KEY)
  } catch {
    // 浏览器不让存就算了，只是加载时会闪一下
  }
}
