// 看大图时的缩放和拖动：滚轮以鼠标位置为中心缩放，放大后按住拖动看别处，双击在「适应窗口」和放大之间切换。
// 换一张图时回到适应窗口。用在 Lightbox 里，所有看大图的地方（附件、文件、视频帧）都有
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'

const MIN = 1
const MAX = 10
/** 双击放大到几倍 */
const DOUBLE = 2.5

type View = { s: number; x: number; y: number }
const FIT: View = { s: 1, x: 0, y: 0 }

/** 以容器里的点 (px, py)（相对容器中心）为中心缩放到 s：这个点下面的画面位置不动 */
export function zoomAt(v: View, s: number, px: number, py: number): View {
  const next = Math.min(MAX, Math.max(MIN, s))
  if (next === MIN) return FIT
  const k = next / v.s
  return { s: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

export function ZoomImage({
  src,
  alt,
  className,
  onBackdrop,
}: {
  src: string
  alt: string
  className?: string
  /** 点了图片以外的空白处（拖动松手不算） */
  onBackdrop?: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [v, setV] = useState<View>(FIT)
  const view = useRef(v)
  view.current = v
  /** 按下后挪动过：松手时不当成点击 */
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const moved = useRef(false)
  useEffect(() => setV(FIT), [src])

  /** 鼠标位置相对容器中心 */
  const at = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect()
    return [cx - r.left - r.width / 2, cy - r.top - r.height / 2] as const
  }
  // 滚轮要能 preventDefault（不让页面跟着滚），React 的 onWheel 是被动监听，只能自己挂
  useEffect(() => {
    const el = box.current
    if (!el) return
    const on = (e: WheelEvent) => {
      e.preventDefault()
      const [px, py] = at(e.clientX, e.clientY)
      setV((cur) => zoomAt(cur, cur.s * Math.exp(-e.deltaY * 0.0015), px, py))
    }
    el.addEventListener('wheel', on, { passive: false })
    return () => el.removeEventListener('wheel', on)
  }, [])

  return (
    <div
      ref={box}
      className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden"
      onPointerDown={(e) => {
        moved.current = false
        if (e.button !== 0 || view.current.s === 1) return
        drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = moved.current = true
        setV((cur) => ({ ...cur, x: d.vx + dx, y: d.vy + dy }))
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={(e) => {
        const [px, py] = at(e.clientX, e.clientY)
        setV((cur) => (cur.s > 1 ? FIT : zoomAt(cur, DOUBLE, px, py)))
      }}
      onClick={(e) => {
        if (moved.current) return
        if (e.target === e.currentTarget) onBackdrop?.()
      }}
      style={{ cursor: drag.current ? 'grabbing' : v.s > 1 ? 'grab' : 'zoom-in' }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className={className}
        style={{
          transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`,
          // 拖动时跟手，缩放、还原时带一点过渡
          transition: drag.current ? 'none' : 'transform 120ms ease-out',
        }}
      />
      {v.s > 1 && (
        <button
          type="button"
          onClick={() => setV(FIT)}
          className="absolute top-0 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-black/60 px-2.5 py-1 font-mono text-footnote text-white/85 tabular-nums hover:bg-black/75"
          title={t('还原到适应窗口')}
        >
          {Math.round(v.s * 100)}%
        </button>
      )}
    </div>
  )
}
