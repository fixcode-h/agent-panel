import { useEffect, useRef, useState } from 'react'
import { HintSurface } from '@/components/ui/hint'

/** 格子的悬停说明分几行写（不合规：原因 / 规则 / 允许的值） */
export interface SheetTip {
  /** 第一行，加粗；danger 时标红（不合规） */
  title?: string
  tone?: 'danger'
  lines: { label: string; text: string }[]
}

/** 鼠标在格子上停这么久才出提示：表格里鼠标一直在格子间划过，太快会满屏乱闪 */
const DELAY_MS = 400

/** 结构化的格子说明：标题一行，下面「名目 · 内容」对齐成两列 */
export function SheetTipView({ tip }: { tip: SheetTip }) {
  return (
    <div className="flex flex-col gap-1">
      {tip.title && (
        <p className={tip.tone === 'danger' ? 'font-medium text-danger' : 'font-medium text-fg'}>{tip.title}</p>
      )}
      {tip.lines.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {tip.lines.map((l, i) => (
            <div key={i} className="contents">
              <dt className="text-subtle">{l.label}</dt>
              <dd className="min-w-0 break-words text-fg">{l.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/**
 * 表格格子的悬停提示：用面板自己的提示浮层（和全站的 Hint 同一套外观），不用浏览器原生 title
 * （原生的出得慢、样式不跟主题，也放不下分几行的不合规说明）。
 *
 * 不给每个格子各包一个 Hint：一屏几百个格子，事件挂在整张表上按坐标找格子就够了。
 * 状态放在这个小组件里，鼠标从一格划到另一格只重画它，不重画整张表。
 * tipOf 返回 null 就不出提示（没截断、没问题的格子）。
 */
export function CellHint({
  grid,
  tipOf,
}: {
  grid: React.RefObject<HTMLDivElement | null>
  tipOf: (cell: HTMLElement) => React.ReactNode
}) {
  const [tip, setTip] = useState<{ rect: DOMRect; content: React.ReactNode } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const fn = useRef(tipOf)
  fn.current = tipOf

  useEffect(() => {
    const el = grid.current
    if (!el) return
    let timer = 0
    let cur: HTMLElement | null = null
    const hide = () => {
      window.clearTimeout(timer)
      timer = 0
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      // 触摸没有悬停
      if (e.pointerType !== 'mouse') return
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[role=cell][data-r]')
      if (cell === cur) return
      cur = cell
      hide()
      if (!cell) return
      timer = window.setTimeout(() => {
        timer = 0
        if (!cell.isConnected || !cell.matches(':hover')) return
        const content = fn.current(cell)
        if (content !== null && content !== undefined && content !== '')
          setTip({ rect: cell.getBoundingClientRect(), content })
      }, DELAY_MS)
    }
    const leave = () => {
      cur = null
      hide()
    }
    // 按下鼠标（开始选、开始拖）、敲键盘（开始改）时提示都碍事，直接收起；指针再动一下会重新算
    const off = () => {
      cur = null
      hide()
    }
    // 表格自己（或外面的容器）滚了才收：别处的滚动（另一栏对话在自动往下滚）不碰这里的提示
    const scroll = (e: Event) => {
      const t = e.target
      if (t === document || t === window || (t instanceof Node && t.contains(el))) off()
    }
    el.addEventListener('pointerover', over, { passive: true })
    el.addEventListener('pointerleave', leave, { passive: true })
    el.addEventListener('pointerdown', off, { passive: true })
    window.addEventListener('scroll', scroll, { capture: true, passive: true })
    window.addEventListener('keydown', off, { capture: true })
    return () => {
      window.clearTimeout(timer)
      el.removeEventListener('pointerover', over)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', off)
      window.removeEventListener('scroll', scroll, { capture: true })
      window.removeEventListener('keydown', off, { capture: true })
    }
  }, [grid])

  return tip ? <HintSurface content={tip.content} anchor={tip.rect} contentRef={contentRef} /> : null
}

/** 格子里的字有没有被截断（胶囊在格子里面，也要看它自己） */
export function cellCut(cell: HTMLElement) {
  if (cell.scrollWidth > cell.clientWidth + 1) return true
  const inner = cell.firstElementChild as HTMLElement | null
  return !!inner && inner.scrollWidth > inner.clientWidth + 1
}
