import { t } from '@shared/i18n'

/**
 * markdown 代码块按文档显示（用户 2026-11-24：「文档定稿」里 Agent 把整份 design.md 包在 ```markdown 里交上来，
 * 弹窗里只看到一大段带行号的源码，表格、引用、类图都没画）。
 * 默认渲染成文档（里面的 mermaid、表格照常画），顶栏「源码」切回带行号的原文；复制始终复制原文（data-src）。
 */
export const DOC_LANGS = new Set(['markdown', 'md'])

/**
 * 包着 mermaid 等代码块的 ```markdown：里面第一个 ``` 会把外层提前关掉，后半截掉出代码块乱成一团。
 * 解析前把这种外层围栏加长到比里面最长的围栏多一个反引号；里面一行裸 ``` 在没有打开的内层时才算外层的结尾。
 */
export function widenDocFences(doc: string) {
  if (!/^ {0,3}`{3,}\s*(?:markdown|md)\b/im.test(doc)) return doc
  const lines = doc.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,})(\s*(?:markdown|md)\b.*)$/i.exec(lines[i])
    if (!open) continue
    let inner = 0
    let longest = 0
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      const f = /^ {0,3}(`{3,})(.*)$/.exec(lines[j])
      if (!f) continue
      longest = Math.max(longest, f[1].length)
      if (f[2].trim()) inner++
      else if (inner) inner--
      else {
        end = j
        break
      }
    }
    if (end < 0 || longest < open[2].length) continue
    const fence = '`'.repeat(longest + 1)
    lines[i] = `${open[1]}${fence}${open[3]}`
    lines[end] = lines[end].replace(/`{3,}/, fence)
    i = end
  }
  return lines.join('\n')
}

/**
 * 文档块的 HTML：顶栏（复用代码块的 bar，多一个「源码」切换）+ 渲染好的正文 + 收起的带行号源码。
 * render 是外层同一套 Markdown 渲染（嵌套调用），source 是外层画好的源码代码块
 */
export function docBlockHtml(
  src: string,
  render: (md: string) => string,
  bar: (extra: string) => string,
  source: string,
) {
  const esc = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const toggle = `<button type="button" class="md-copy" data-mdview><span class="md-docblock-to-src">${t('源码')}</span><span class="md-docblock-to-doc">${t('文档')}</span></button>`
  return `<div class="md-code md-docblock" data-view="doc" data-src="${esc}">${bar(toggle)}<div class="md-docblock-body">${render(src)}</div>${source}</div>`
}
