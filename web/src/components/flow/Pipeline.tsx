import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type EdgeTone = 'idle' | 'done' | 'active' | 'failed'

export interface PipelineItem {
  key: string
  node: React.ReactNode
}

export interface PipelineColumn {
  key: string
  header?: React.ReactNode
  items: PipelineItem[]
  footer?: React.ReactNode
  /** 列宽，默认 232 */
  width?: number
  /** 拖放等事件挂在整列上 */
  props?: React.HTMLAttributes<HTMLDivElement>
  className?: string
}

interface Edge {
  d: string
  tone: EdgeTone
  key: string
}

const stroke: Record<EdgeTone, string> = {
  idle: 'var(--line-strong)',
  done: 'var(--success)',
  active: 'var(--accent)',
  failed: 'var(--danger)',
}

/**
 * CI 风格的流程图布局：列从左到右，每列是一组并行的节点，相邻两列之间的节点两两连线。
 * 节点位置从 DOM 量出来，所以卡片高度可以随内容变化。
 */
export function Pipeline({
  columns,
  edgeTone = () => 'idle',
  gap,
  trailing,
  className,
  focus,
}: {
  columns: PipelineColumn[]
  edgeTone?: (from: string, to: string) => EdgeTone
  /** 第 i 列和第 i+1 列之间的内容（例如插入按钮）；i = -1 表示第一列之前 */
  gap?: (i: number) => React.ReactNode
  trailing?: React.ReactNode
  className?: string
  /** 滚动到这个节点（item key），例如正在执行的节点 */
  focus?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const [edges, setEdges] = useState<Edge[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  const measure = () => {
    const el = box.current
    if (!el) return
    const base = el.getBoundingClientRect()
    const rect = (k: string) => {
      const n = nodes.current.get(k)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return {
        l: r.left - base.left,
        r: r.right - base.left,
        y: r.top - base.top + Math.min(r.height / 2, 30),
      }
    }
    const next: Edge[] = []
    for (let c = 0; c < columns.length - 1; c++) {
      for (const a of columns[c].items) {
        const ra = rect(`${columns[c].key}/${a.key}`)
        if (!ra) continue
        for (const b of columns[c + 1].items) {
          const rb = rect(`${columns[c + 1].key}/${b.key}`)
          if (!rb) continue
          const dx = Math.max(16, (rb.l - ra.r) / 2)
          next.push({
            key: `${a.key}>${b.key}`,
            tone: edgeTone(a.key, b.key),
            d: `M${ra.r} ${ra.y} C${ra.r + dx} ${ra.y} ${rb.l - dx} ${rb.y} ${rb.l} ${rb.y}`,
          })
        }
      }
    }
    // 执行中的线画在最上面
    const order: EdgeTone[] = ['idle', 'done', 'failed', 'active']
    next.sort((x, y) => order.indexOf(x.tone) - order.indexOf(y.tone))
    setEdges((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next))
    setSize((s) => (s.w === el.scrollWidth && s.h === el.scrollHeight ? s : { w: el.scrollWidth, h: el.scrollHeight }))
  }

  useLayoutEffect(measure)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  })

  useLayoutEffect(() => {
    const sc = scroller.current
    const el = focus && [...nodes.current.entries()].find(([k]) => k.endsWith(`/${focus}`))?.[1]
    if (!sc || !el) return
    const a = sc.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    if (b.left >= a.left && b.right <= a.right) return
    sc.scrollTo({ left: sc.scrollLeft + b.left - a.left - (a.width - b.width) / 2, behavior: 'smooth' })
  }, [focus])

  const reg = (k: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(k, el)
    else nodes.current.delete(k)
  }

  return (
    <div ref={scroller} className={cn('overflow-x-auto', className)}>
      <div ref={box} className="relative flex w-max min-w-full items-stretch px-1 py-1">
        <svg className="pointer-events-none absolute top-0 left-0" width={size.w} height={size.h} aria-hidden>
          {edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              stroke={stroke[e.tone]}
              strokeOpacity={e.tone === 'done' ? 0.55 : 1}
              strokeWidth={e.tone === 'idle' ? 1.5 : 2}
              className={e.tone === 'active' ? 'edge-active' : undefined}
            />
          ))}
        </svg>
        {gap?.(-1)}
        {columns.map((col, ci) => (
          <div key={col.key} className="flex items-stretch">
            <div
              {...col.props}
              className={cn('relative flex shrink-0 flex-col gap-3', col.className)}
              style={{ width: col.width ?? 232 }}
            >
              {col.header}
              <div className="flex flex-col gap-3">
                {col.items.map((it) => (
                  <div key={it.key} ref={reg(`${col.key}/${it.key}`)}>
                    {it.node}
                  </div>
                ))}
              </div>
              {col.footer}
            </div>
            {ci < columns.length - 1 && (gap ? gap(ci) : <div className="w-14 shrink-0" />)}
          </div>
        ))}
        {trailing}
      </div>
    </div>
  )
}
