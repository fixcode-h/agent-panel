import { useMemo } from 'react'
import { escapeHtml, maxCols } from '@/lib/file-highlight'

/** 一块画多少行：整块拼成一段 HTML 交给浏览器解析，比几千个 React 元素快得多 */
const CHUNK = 200
/** 制表符宽度：和编辑区一致，切换阅读 / 编辑时缩进不跳 */
const TAB = 4
/** 行号列宽（w-14）和代码右边留白（pr-4），撑宽度时要加上 */
const GUTTER = '4.5rem'

// 和以前逐行渲染的样式一致：不画斑马纹（深色下隔行底色明暗差太大，用户 2026-10-31 反馈），
// 悬停那一行淡淡高亮帮着横向对行；跳到的那一行用强调色盖过悬停
const ROW = 'flex whitespace-pre hover:bg-fg/4'
const ROW_ON = 'flex whitespace-pre bg-accent/12'
const NUM = 'w-14 shrink-0 pr-3 text-right text-subtle/55 select-none'
const CODE = 'pr-4'
const PLAIN = 'pr-4 text-fg/90'

/**
 * 文件弹窗阅读时的代码：带行号、语法高亮，每一行有 data-line 供跳转定位。
 *
 * 大文件（几千行、上百 KB）逐行渲染成 React 元素再交给浏览器排版，一打开就卡好几秒。这里每 CHUNK 行拼成一段 HTML，
 * 每块加 content-visibility: auto：屏幕外的块不排版、不绘制，高度按行数预留，滚到哪画到哪；
 * 内容都还在 DOM 里，浏览器的查找（Ctrl+F）和跳到某一行照样能用。
 */
export function CodeLines({
  lines,
  highlighted,
  target,
}: {
  lines: string[]
  /** 每一行高亮后的 HTML；整体为 null 或某一行为 undefined 时按纯文本画 */
  highlighted: (string | undefined)[] | null
  /** 跳到的那一行（从 1 数） */
  target?: number
}) {
  const chunks = useMemo(() => {
    const out: { html: string; rows: number }[] = []
    for (let start = 0; start < lines.length; start += CHUNK) {
      const end = Math.min(lines.length, start + CHUNK)
      let html = ''
      for (let i = start; i < end; i++) {
        const n = i + 1
        const hl = highlighted?.[i]
        // 高亮结果是 highlight.js 生成的，内容已经过它转义；纯文本自己转义
        const code =
          hl !== undefined
            ? `<span class="${CODE}">${hl || ' '}</span>`
            : `<span class="${PLAIN}">${escapeHtml(lines[i]) || ' '}</span>`
        html += `<div data-line="${n}" class="${n === target ? ROW_ON : ROW}"><span class="${NUM}">${n}</span>${code}</div>`
      }
      out.push({ html, rows: end - start })
    }
    return out
  }, [lines, highlighted, target])
  // 屏幕外的块不排版，宽度按最长的一行事先撑好：往下滚到长行时横向滚动条不突然变长
  const cols = useMemo(() => maxCols(lines, TAB), [lines])
  return (
    <pre className="min-w-max py-2 font-mono text-footnote leading-[1.6] [tab-size:4]">
      {/* 只撑宽度的空行：估得偏窄时 min-w-max 仍按真画出来的内容撑开 */}
      <div aria-hidden style={{ width: `calc(${cols}ch + ${GUTTER})` }} />
      {chunks.map((c, i) => (
        <div
          key={i}
          // 每行高度就是一个行高（1.6em），预留的高度和真画出来的一样，滚动条不跳；宽度跟着外层，不用预留
          style={{ contentVisibility: 'auto', containIntrinsicBlockSize: `auto ${c.rows * 1.6}em` }}
          dangerouslySetInnerHTML={{ __html: c.html }}
        />
      ))}
    </pre>
  )
}
