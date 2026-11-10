import type { TokenizerAndRendererExtension } from 'marked'

/**
 * Markdown 里的数学公式（设计报告 Chat P1-6）：marked 是同步解析，KaTeX 体积不小，所以这里只认出公式、
 * 输出带原文的占位（.md-math，显示的是原文），渲染组件不在流式输出时再懒加载 KaTeX 换成公式
 * （web/src/components/tasks/Markdown.tsx，和 mermaid 同一个做法）。
 *
 * 认的写法：独占一块的 $$…$$、\[…\]；行内的 $…$、\(…\)。行内 $…$ 要避开「$5 和 $10」这类金额：
 * 开头的 $ 后面、结尾的 $ 前面都不能是空格，结尾的 $ 后面不能紧跟数字，里面不跨行
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const box = (tex: string, display: boolean) => {
  const tag = display ? 'div' : 'span'
  return `<${tag} class="md-math${display ? ' md-math-block' : ''}" data-tex="${esc(tex)}">${esc(
    display ? `$$${tex}$$` : `$${tex}$`,
  )}</${tag}>`
}

const block: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  // marked 每切一段正文都会用剩下的整篇调一次 start：每次都扫到文末，长文档（几百 KB 的 Markdown 文件）就是平方级。
  // 段落到空行就结束，公式只可能在这一段里打断它，只看到第一个空行为止
  start: (src) => {
    const blank = /\n[ \t]*\n/.exec(src)
    return (blank ? src.slice(0, blank.index + 1) : src).match(/^\s*(\$\$|\\\[)/m)?.index
  },
  tokenizer(src) {
    const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(src)
    if (!m) return undefined
    return { type: 'mathBlock', raw: m[0], text: (m[1] ?? m[2]).trim() }
  },
  renderer: (tok) => box(String(tok.text), true),
}

const inline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    const paren = /^\\\((.+?)\\\)/.exec(src)
    if (paren) return { type: 'mathInline', raw: paren[0], text: paren[1].trim() }
    const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src)
    if (!m) return undefined
    return { type: 'mathInline', raw: m[0], text: m[1] }
  },
  renderer: (tok) => box(String(tok.text), false),
}

export const mathExtensions = [block, inline]
