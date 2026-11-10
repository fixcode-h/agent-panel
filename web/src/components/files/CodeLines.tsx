import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { escapeHtml, maxCols, type HlLines } from '@/lib/file-highlight'
import { markHtml, type LineMark } from '@/lib/file-search'

/** 一块多少行：滚动时按块增减，屏幕上同时只有三四块；块里的行不跟着滚动重画 */
const BLOCK = 80
/** 制表符宽度：和编辑区一致，切换阅读 / 编辑时缩进不跳 */
const TAB = 4
/** 行号列宽（w-14）和代码右边留白（pr-4），撑宽度时要加上 */
const GUTTER = '4.5rem'
/** 上下内边距（py-2），行的位置要加上 */
const PAD = 8

// 和以前逐行渲染的样式一致：不画斑马纹（深色下隔行底色明暗差太大，用户 2026-10-31 反馈），
// 悬停那一行淡淡高亮帮着横向对行；跳到的那一行用强调色盖过悬停
const ROW = 'flex whitespace-pre hover:bg-fg/4'
const ROW_ON = 'flex whitespace-pre bg-accent/12'
const NUM = 'w-14 shrink-0 pr-3 text-right text-subtle/55 select-none'
const CODE = 'pr-4'
const PLAIN = 'pr-4 text-fg/90'

/** 拼一块的 HTML：每一行有 data-line 供定位，搜索命中套 <mark> */
function blockHtml(
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
    html += `<div data-line="${n}" class="${n === target ? ROW_ON : ROW}"><span class="${NUM}">${n}</span><span class="${hl !== undefined ? CODE : PLAIN}">${code || ' '}</span></div>`
  }
  return html
}

/**
 * 文件弹窗阅读时的代码：带行号、语法高亮，只画屏幕上看得见的那几块（虚拟列表），几千行的文件打开也只有几百个节点。
 * 每块按自己的序号绝对定位，行高取真画出来的高度：浏览器排版按 1/64 像素取整，按 CSS 行高乘出来滚到几千行会错开。
 * 屏幕外的行不在页面里，浏览器自带的查找搜不到，搜索由弹窗自己做（FileSearchBar），命中从 marks 传进来。
 */
export function CodeLines({
  lines,
  highlighted,
  target,
  scrollEl,
  marks,
  current,
}: {
  lines: string[]
  /** 每一行高亮后的 HTML；整体为 null 或某一行为 undefined 时按纯文本画 */
  highlighted: HlLines | null
  /** 跳到的那一行（从 1 数）：打开时滚到中间 */
  target?: number
  /** 外面的滚动容器 */
  scrollEl: React.RefObject<HTMLDivElement | null>
  /** 搜索命中，按行（从 0 数）分好 */
  marks?: Map<number, LineMark[]>
  /** 当前那一处命中在第几行（从 0 数）：变了就滚过去 */
  current?: { line: number; seq: number } | null
}) {
  const [rowH, setRowH] = useState(19.2)
  /** 画哪几块（闭区间）：只在跨块时变，平时滚动不重新渲染 */
  const [win, setWin] = useState({ from: 0, to: 1 })
  const firstBlock = useRef<HTMLDivElement>(null)
  const rowHRef = useRef(rowH)
  rowHRef.current = rowH
  const blocks = Math.ceil(lines.length / BLOCK)
  const span = BLOCK * rowH

  // 跟着外面的滚动容器算看得见哪几块；行高量准了、行数变了也重算
  useEffect(() => {
    const box = scrollEl.current
    if (!box) return
    let frame = 0
    const read = () => {
      frame = 0
      // 上下各多画一块，滚一点点不用等新块
      const from = Math.max(0, Math.floor((box.scrollTop - PAD) / span) - 1)
      const to = Math.max(from, Math.min(blocks - 1, Math.floor((box.scrollTop + box.clientHeight) / span) + 1))
      setWin((w) => (w.from === from && w.to === to ? w : { from, to }))
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    box.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(box)
    return () => {
      box.removeEventListener('scroll', later)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollEl, span, blocks])
  const shown: number[] = []
  for (let b = win.from; b <= Math.min(win.to, blocks - 1); b++) shown.push(b)

  // 量真实行高：拿画出来的一整块的高度除以行数
  useLayoutEffect(() => {
    const el = firstBlock.current
    const rows = Number(el?.dataset.rows ?? 0)
    if (!el || !rows) return
    const h = el.getBoundingClientRect().height / rows
    if (h > 0 && Math.abs(h - rowHRef.current) > 0.0005) setRowH(h)
    // 画的块换了、内容换了才重新量；量出来和现在一样就不再 setState，不会来回渲染
  }, [win, lines])

  // 打开时滚到提到的那一行
  useLayoutEffect(() => {
    const box = scrollEl.current
    if (!box || !target) return
    box.scrollTop = Math.max(0, PAD + (target - 1) * rowHRef.current - box.clientHeight / 2)
    // 只在换了文件 / 行号时跳一次，行高量准之后不再跳
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [target, lines.length > 0])

  // 搜索换到下一处：先把那一行滚进来（不在屏幕上时滚到中间），画出来之后再横向对准那个词
  useLayoutEffect(() => {
    const box = scrollEl.current
    if (!box || !current) return
    const y = PAD + current.line * rowHRef.current
    if (y < box.scrollTop || y + rowHRef.current > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, y - box.clientHeight / 2)
    // 滚过去之后新的块要等下一帧才画出来：多等几帧找那个词
    let tries = 0
    let frame = 0
    const align = () => {
      const mark = box.querySelector('mark[data-current]')
      if (mark) mark.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      else if (tries++ < 5) frame = requestAnimationFrame(align)
    }
    frame = requestAnimationFrame(align)
    return () => cancelAnimationFrame(frame)
  }, [current, scrollEl])

  const cols = useMemo(() => maxCols(lines, TAB), [lines])
  return (
    <pre
      className="relative min-w-max font-mono text-footnote leading-[1.6] [tab-size:4]"
      style={{ height: lines.length * rowH + PAD * 2 }}
    >
      {/* 只撑宽度的空行：屏幕外的块不在页面里，宽度按最长的一行事先撑好，往下滚到长行时横向滚动条不突然变长 */}
      <div aria-hidden style={{ width: `calc(${cols}ch + ${GUTTER})` }} />
      {shown.map((b) => (
        <div
          key={b}
          ref={b === shown[0] ? firstBlock : undefined}
          data-rows={Math.min(BLOCK, lines.length - b * BLOCK)}
          className="absolute left-0 min-w-full"
          style={{ top: PAD + b * span }}
          dangerouslySetInnerHTML={{ __html: blockHtml(lines, highlighted, b * BLOCK, target, marks) }}
        />
      ))}
    </pre>
  )
}
