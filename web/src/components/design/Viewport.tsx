import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { findParent, findWidget, type Component, type Vec2, type Widget } from '@shared/umg'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { UmgNode, type RenderImage } from './umg-render'
import type { Annotation, AnnotationKind } from '@shared/design'
import { AnnotationLayer, AnnotationToolbar, TOOL_KEYS, isMarkTool, widgetsIn, type Tool } from './Annotations'

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
  annotations,
  onAnnotations,
  target,
}: {
  root: Widget
  size: Vec2
  images: Map<string, RenderImage>
  components: Component[]
  selected: string
  onSelect: (id: string) => void
  /** 拖动 / 改大小：dx、dy 是设计稿像素；mode 为 resize 时改宽高 */
  onMove: (id: string, d: { dx: number; dy: number; mode: 'move' | 'resize' }, key: string) => void
  /** 全部标注（各棵树的都在里面，这里只显示当前这棵的） */
  annotations: Annotation[]
  onAnnotations: (list: Annotation[], key: string) => void
  /** 正在编辑的树：空是主界面，否则是子控件名 */
  target: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(0)
  const [fit, setFit] = useState(0.5)
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const scale = zoom || fit
  const [tool, setTool] = useState<Tool>('select')
  const [kind, setKind] = useState<AnnotationKind>('change')
  const [showMarks, setShowMarks] = useState(true)
  const [activeMark, setActiveMark] = useState('')
  const marks = annotations.filter((a) => a.target === target)
  const setMarks = (fn: (l: Annotation[]) => Annotation[], key: string) => onAnnotations(fn(annotations), key)

  // 工具快捷键：V 选择、H 拖动、R 框选、A 箭头、P 画笔、T 打点；Esc 回到选择
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') {
        setTool('select')
        setActiveMark('')
        return
      }
      const next = TOOL_KEYS[e.key.toLowerCase()]
      if (next) {
        setTool(next)
        if (isMarkTool(next)) setShowMarks(true)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  // 拖动画布：抓手工具下左键拖，任何时候中键拖
  const pan = (e: React.PointerEvent) => {
    const el = wrap.current
    if (!el || !(e.button === 1 || (tool === 'hand' && e.button === 0))) return false
    e.preventDefault()
    const sx = e.clientX + el.scrollLeft
    const sy = e.clientY + el.scrollTop
    const move = (ev: PointerEvent) => {
      el.scrollLeft = sx - ev.clientX
      el.scrollTop = sy - ev.clientY
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return true
  }

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

  const play = tool === 'play'
  const ctx = { images, components: new Map(components.map((c) => [c.Name, c])), interactive: true, depth: 0, play }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#18181a]">
      <div
        ref={wrap}
        className={cn('relative min-h-0 flex-1 overflow-auto', tool === 'hand' && 'cursor-grab active:cursor-grabbing')}
        onPointerDownCapture={(e) => {
          if (pan(e)) e.stopPropagation()
        }}
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
          className="grid min-h-full min-w-full place-items-center px-6 pt-16 pb-12"
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
                if (tool !== 'select') return
                const el = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')
                const id = el?.dataset.wid ?? ''
                onSelect(id)
                // 点到的就是选中的、能拖动的控件时直接开始拖
                if (id && id === selected) drag(e, 'move')
              }}
            >
              <UmgNode w={root} ctx={ctx} />
            </div>
            {box && !play && (
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
            {!root.Children?.length && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-[320px] text-[12.5px] leading-relaxed text-white/45">
                  <p className="mb-1 text-[13.5px] font-medium text-white/70">{t('还是空白界面')}</p>
                  {t('在右边告诉 AI 想要什么界面，或者用控件树上的 + 添加控件。')}
                </div>
              </div>
            )}
            <AnnotationLayer
              size={size}
              scale={scale}
              tool={tool}
              kind={kind}
              list={marks}
              visible={showMarks && !play}
              active={activeMark}
              onActive={setActiveMark}
              onCreate={(a) => {
                const mark: Annotation = {
                  ...a,
                  id: crypto.randomUUID(),
                  note: '',
                  target,
                  widgets: stage.current ? widgetsIn(stage.current, scale, root, a) : [],
                }
                setMarks((l) => [...l, mark], `ann:add:${mark.id}`)
                // 画完马上写说明
                setActiveMark(mark.id)
              }}
              onChange={(a) => setMarks((l) => l.map((x) => (x.id === a.id ? a : x)), `ann:${a.id}`)}
              onRemove={(id) => {
                setMarks((l) => l.filter((x) => x.id !== id), `ann:rm:${id}`)
                setActiveMark('')
              }}
            />
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
        <AnnotationToolbar
          tool={tool}
          onTool={(x) => {
            setTool(x)
            if (isMarkTool(x)) setShowMarks(true)
          }}
          kind={kind}
          onKind={(k) => {
            setKind(k)
            if (!isMarkTool(tool)) setTool('rect')
          }}
          count={marks.length}
          visible={showMarks}
          onToggleVisible={() => setShowMarks((v) => !v)}
          onClear={() => {
            setMarks((l) => l.filter((x) => x.target !== target), 'ann:clear')
            setActiveMark('')
          }}
        />
      </div>
      {play && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1 text-[11.5px] text-emerald-200 shadow-pop">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {t('运行模式 · 按 Esc 退出')}
          </span>
        </div>
      )}
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
