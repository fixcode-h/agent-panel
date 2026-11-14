import { escapeHtml, type HlLines } from '@/lib/file-highlight'
import { markHtml, type LineMark } from '@/lib/file-search'

/** 一块多少行：滚动时按块增减，屏幕上同时只有三四块；块里的行不跟着滚动重画 */
export const BLOCK = 80

// 和以前逐行渲染的样式一致：不画斑马纹（深色下隔行底色明暗差太大，用户 2026-10-31 反馈），
// 悬停那一行淡淡高亮帮着横向对行；跳到的那一行用强调色盖过悬停。行底色和钉住的行号底色在 index.css 的 .cl-row / .cl-num
// 行高定死成一行字高：块是按「行数 × 行高」绝对定位的，哪一行被撑高，这一块就会盖住下一块（用户 2026-11-14 报文字叠在一起）
const ROW = 'cl-row flex h-[1.6em] whitespace-pre'
// 行号横向滚动时钉在左边（用户 2026-11-12）：代码从它下面滚过去
const NUM = 'cl-num w-14 shrink-0 pr-3 text-right text-subtle/55 select-none'
const CODE = 'pr-4'
const PLAIN = 'pr-4 text-fg/90'

/** 拼一块的 HTML：每一行有 data-line 供定位，搜索命中套 <mark> */
export function blockHtml(
  lines: string[],
  highlighted: HlLines | null,
  start: number,
  target: number | undefined,
  marks: Map<number, LineMark[]> | undefined,
) {
  const end = Math.min(lines.length, start + BLOCK)
  let html = ''
  for (let i = start; i < end; i++) {
    const n = i + 1
    const hl = highlighted?.[i]
    // 高亮结果是 highlight.js 生成的，内容已经过它转义；纯文本自己转义
    let code = hl !== undefined ? hl : escapeHtml(lines[i])
    const m = marks?.get(i)
    if (m) code = markHtml(code, m)
    // 拆行只按 \n：落单的 \r（\r\r\n 这种混合换行，UE 源码里常见）塞进 innerHTML 会被 HTML 解析成换行，
    // 一行变成两行高，后面整块错位；去掉 \r 不影响搜索命中的位置（命中已经套好 <mark>）
    code = code.replace(/\r/g, '')
    html += `<div data-line="${n}"${n === target ? ' data-on' : ''} class="${ROW}"><span class="${NUM}">${n}</span><span class="${hl !== undefined ? CODE : PLAIN}">${code || ' '}</span></div>`
  }
  return html
}
