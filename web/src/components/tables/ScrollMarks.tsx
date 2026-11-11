import { useEffect, useMemo, useRef } from 'react'
import { t } from '@shared/i18n'

/** 一种标记：哪些行（行号）、什么颜色（CSS 变量名） */
export interface MarkLayer {
  rows: Iterable<number>
  color: string
}

/** 标记条宽度：压在滚动条最右边，不挡滚动条中间的滑块 */
const W = 4

/**
 * 表格右侧滚动条上的位置标记：不合规（红）、改过（强调色）、搜索命中（黄）各在哪，点一下跳过去。
 * 画在一个 canvas 上、按像素合并：一万行的表也只是几十个小色块，不加 DOM
 */
export function ScrollMarks({
  order,
  layers,
  onJump,
}: {
  /** 显示着的行（筛选排序后），标记按它们在里面的位置画 */
  order: number[]
  /** 后面的盖住前面的 */
  layers: MarkLayer[]
  onJump: (row: number) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const at = useMemo(() => new Map(order.map((r, i) => [r, i])), [order])
  // 每层的位置（在 order 里第几个），排好序：画的时候和点的时候都用
  const idx = useMemo(
    () =>
      layers.map((l) => {
        const out: number[] = []
        for (const r of l.rows) {
          const i = at.get(r)
          if (i !== undefined) out.push(i)
        }
        return { color: l.color, list: out.sort((a, b) => a - b) }
      }),
    [layers, at],
  )
  const any = idx.some((l) => l.list.length)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const draw = () => {
      const h = el.clientHeight
      const dpr = window.devicePixelRatio || 1
      el.width = W * dpr
      el.height = h * dpr
      const g = el.getContext('2d')
      if (!g || !order.length) return
      g.scale(dpr, dpr)
      const css = getComputedStyle(el)
      for (const l of idx) {
        g.fillStyle = css.getPropertyValue(l.color).trim() || l.color
        // 同一个像素行里的只画一次；相邻的连成一段
        let y0 = -1
        let y1 = -1
        for (const i of l.list) {
          const y = Math.floor((i / order.length) * h)
          if (y0 >= 0 && y <= y1 + 1) {
            y1 = Math.max(y1, y + 1)
            continue
          }
          if (y0 >= 0) g.fillRect(0, y0, W, Math.max(2, y1 - y0 + 1))
          y0 = y
          y1 = y + 1
        }
        if (y0 >= 0) g.fillRect(0, y0, W, Math.max(2, y1 - y0 + 1))
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [idx, order.length])

  if (!any) return null
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={t('滚动条标记')}
      title={t('点一下跳到附近的标记')}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect()
        const want = ((e.clientY - box.top) / box.height) * order.length
        // 找离点的位置最近的一处标记（几个像素以内）
        const tol = (4 / box.height) * order.length + 1
        let best = -1
        for (const l of idx)
          for (const i of l.list)
            if (Math.abs(i - want) <= tol && (best < 0 || Math.abs(i - want) < Math.abs(best - want))) best = i
        if (best >= 0) onJump(order[best])
      }}
      className="absolute top-0 right-0 h-full z-[4] cursor-pointer"
      // canvas 是替换元素，top / bottom 撑不开高度，要写明 100%
      style={{ width: W }}
    />
  )
}
