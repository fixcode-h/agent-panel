import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { findParent, findWidget, type Component, type Vec2, type Widget } from '@shared/umg'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { UmgNode, type RenderImage } from './umg-render'

/**
 * 效果展示区：按设计稿尺寸画出界面，可以缩放；点选控件，CanvasPanel 里的控件可以拖动位置、拖右下角改大小。
 */
export function Viewport({
  root,
  size,
  images,
  components,
  selected,
  onSelect,
  onMove,
}: {
  root: Widget
  size: Vec2
  images: Map<string, RenderImage>
  components: Component[]
  selected: string
  onSelect: (id: string) => void
  /** 拖动 / 改大小：dx、dy 是设计稿像素；mode 为 resize 时改宽高 */
  onMove: (id: string, d: { dx: number; dy: number; mode: 'move' | 'resize' }, key: string) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(0)
  const [fit, setFit] = useState(0.5)
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const scale = zoom || fit

  // 适应窗口的缩放比例
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const calc = () => {
      const r = el.getBoundingClientRect()
      setFit(Math.max(0.05, Math.min((r.width - 48) / size.X, (r.height - 48) / size.Y, 2)))
    }
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(el)
    return () => ro.disconnect()
  }, [size.X, size.Y])

  // 选中框跟着控件走：每帧量一次（图片加载、布局变化都会影响位置）
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const st = stage.current
      const el = selected ? st?.querySelector<HTMLElement>(`[data-wid="${CSS.escape(selected)}"]`) : null
      if (st && el) {
        const a = st.getBoundingClientRect()
        const b = el.getBoundingClientRect()
        const next = {
          x: (b.left - a.left) / scale,
          y: (b.top - a.top) / scale,
          w: b.width / scale,
          h: b.height / scale,
        }
        setBox((cur) =>
          cur &&
          Math.abs(cur.x - next.x) + Math.abs(cur.y - next.y) + Math.abs(cur.w - next.w) + Math.abs(cur.h - next.h) <
            0.5
            ? cur
            : next,
        )
      } else setBox(null)
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [selected, scale])

  const parent = selected ? findParent(root, selected) : undefined
  const movable = parent?.Type === 'CanvasPanel' && !!findWidget(root, selected)?.Slot

  const drag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    if (!movable) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    let lx = 0
    let ly = 0
    const key = `${mode}:${selected}:${Date.now()}`
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - sx) / scale)
      const dy = Math.round((ev.clientY - sy) / scale)
      if (dx === lx && dy === ly) return
      onMove(selected, { dx: dx - lx, dy: dy - ly, mode }, key)
      lx = dx
      ly = dy
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const ctx = { images, components: new Map(components.map((c) => [c.Name, c])), interactive: true, depth: 0 }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#18181a]">
      <div
        ref={wrap}
        className="relative min-h-0 flex-1 overflow-auto"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect('')
        }}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return
          e.preventDefault()
          setZoom((z) => Math.max(0.05, Math.min(4, (z || fit) * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
        }}
      >
        <div
          className="grid min-h-full min-w-full place-items-center p-6"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onSelect('')
          }}
        >
          <div style={{ width: size.X * scale, height: size.Y * scale }} className="relative shrink-0">
            <div
              ref={stage}
              style={{ width: size.X, height: size.Y, transform: `scale(${scale})`, transformOrigin: '0 0' }}
              className="absolute top-0 left-0 overflow-hidden bg-[#0e0e10] bg-[length:24px_24px] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_12px_40px_-12px_rgba(0,0,0,0.8)] [background-image:linear-gradient(45deg,#1a1a1d_25%,transparent_25%,transparent_75%,#1a1a1d_75%),linear-gradient(45deg,#1a1a1d_25%,transparent_25%,transparent_75%,#1a1a1d_75%)] [background-position:0_0,12px_12px]"
              onPointerDown={(e) => {
                const el = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')
                const id = el?.dataset.wid ?? ''
                onSelect(id)
                // 点到的就是选中的、能拖动的控件时直接开始拖
                if (id && id === selected) drag(e, 'move')
              }}
            >
              <UmgNode w={root} ctx={ctx} />
            </div>
            {box && (
              <div
                className="pointer-events-none absolute"
                style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale }}
              >
                <div className="absolute inset-0 outline-[1.5px] outline-[#4c9bff] outline-solid" />
                {movable && (
                  <div
                    onPointerDown={(e) => drag(e, 'resize')}
                    title={t('拖动改变大小')}
                    className="pointer-events-auto absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-[2px] border border-[#4c9bff] bg-white"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-2">
        <span className="rounded-md bg-black/50 px-2 py-1 font-mono text-[11px] text-white/60">
          {size.X} × {size.Y}
        </span>
        <div className="pointer-events-auto flex items-center rounded-lg border border-white/10 bg-[#232326]/95 text-white/80 shadow-pop">
          <ZoomButton label={t('缩小')} onClick={() => setZoom(Math.max(0.05, scale / 1.25))}>
            <Minus className="h-3.5 w-3.5" />
          </ZoomButton>
          <button
            onClick={() => setZoom(1)}
            title={t('原始大小')}
            className="h-7 w-12 cursor-pointer font-mono text-[11.5px] tabular-nums hover:text-white"
          >
            {Math.round(scale * 100)}%
          </button>
          <ZoomButton label={t('放大')} onClick={() => setZoom(Math.min(4, scale * 1.25))}>
            <Plus className="h-3.5 w-3.5" />
          </ZoomButton>
          <ZoomButton label={t('适应窗口')} onClick={() => setZoom(0)} on={!zoom}>
            <Maximize className="h-3.5 w-3.5" />
          </ZoomButton>
        </div>
      </div>
    </div>
  )
}

function ZoomButton({
  label,
  onClick,
  children,
  on,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  on?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'grid h-7 w-7 cursor-pointer place-items-center rounded-md hover:text-white',
        on && 'text-[#4c9bff]',
      )}
    >
      {children}
    </button>
  )
}
