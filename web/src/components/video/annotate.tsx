// 帧上的标注：画面上显示（SVG，跟着图片缩放）、编辑（框 · 箭头 · 文字，四种颜色，撤销）、发送前画成 PNG（canvas）。
// 坐标都是相对图片宽高的比例（shared/video-tools.ts 的 FrameShape），缩略图、大图、增强图上都画在同一个位置。
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Square, Trash2, Type, Undo2, X } from 'lucide-react'
import { SHAPE_COLORS, SHAPES_MAX, type DiffBox, type FrameShape } from '@shared/video-tools'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 线宽、字号按图片宽度算：大图小图看起来一样粗 */
const strokeOf = (w: number) => Math.max(2, Math.round(w / 320))
const fontOf = (w: number) => Math.max(14, Math.round(w / 42))

/** 估算一句备注画出来多宽（SVG 里量不了字宽）：中日韩字按一个字号算，其他按 0.6 个 */
const textWidth = (text: string, fs: number) =>
  [...text].reduce((w, c) => w + (/[\u2e80-\uffff]/.test(c) ? fs : fs * 0.6), 0)

/** 箭头头部的两个点 */
function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const p = (d: number) => [x2 - size * Math.cos(a + d), y2 - size * Math.sin(a + d)] as const
  return [p(Math.PI / 7), p(-Math.PI / 7)] as const
}

/** 标注的 SVG（viewBox 是图片的像素尺寸）：显示和编辑共用 */
export function ShapesSvg({
  shapes,
  width,
  height,
  boxes,
  className,
  children,
  ...rest
}: {
  shapes: FrameShape[]
  width: number
  height: number
  /** 帧差的变化框：虚线，和标注区分开 */
  boxes?: DiffBox[]
  className?: string
  children?: React.ReactNode
} & React.SVGProps<SVGSVGElement>) {
  const sw = strokeOf(width)
  const fs = fontOf(width)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn('absolute inset-0 h-full w-full', className)} {...rest}>
      {boxes?.map((b, i) => (
        <rect
          key={`d${i}`}
          x={b.x * width}
          y={b.y * height}
          width={b.w * width}
          height={b.h * height}
          fill="rgba(250,204,21,0.12)"
          stroke="#facc15"
          strokeWidth={sw}
          strokeDasharray={`${sw * 4} ${sw * 3}`}
        />
      ))}
      {shapes.map((s, i) => {
        if (s.kind === 'rect')
          return (
            <rect
              key={i}
              x={s.x * width}
              y={s.y * height}
              width={s.w * width}
              height={s.h * height}
              fill="none"
              stroke={s.color}
              strokeWidth={sw * 1.5}
              rx={sw}
            />
          )
        if (s.kind === 'arrow') {
          const [x1, y1, x2, y2] = [s.x1 * width, s.y1 * height, s.x2 * width, s.y2 * height]
          const [a, b] = arrowHead(x1, y1, x2, y2, sw * 7)
          return (
            <g key={i} stroke={s.color} strokeWidth={sw * 1.5} strokeLinecap="round" strokeLinejoin="round">
              <line x1={x1} y1={y1} x2={x2} y2={y2} />
              <polygon points={`${x2},${y2} ${a[0]},${a[1]} ${b[0]},${b[1]}`} fill={s.color} />
            </g>
          )
        }
        return (
          <g key={i}>
            <rect
              x={s.x * width}
              y={s.y * height}
              width={Math.min(width - s.x * width, textWidth(s.text, fs) + fs * 0.8)}
              height={fs * 1.5}
              rx={fs * 0.25}
              fill="rgba(0,0,0,0.72)"
            />
            <text
              x={s.x * width + fs * 0.4}
              y={s.y * height + fs * 1.08}
              fill={s.color}
              fontSize={fs}
              fontWeight={600}
              fontFamily="system-ui, sans-serif"
            >
              {s.text}
            </text>
          </g>
        )
      })}
      {children}
    </svg>
  )
}

type Tool = 'rect' | 'arrow' | 'text'

/**
 * 标注编辑：盖在图片上，按住拖出框 / 箭头，点一下放文字。上方浮一条工具栏：工具、颜色、撤销、清空、取消、完成
 */
export function Annotator({
  initial,
  width,
  height,
  onCancel,
  onDone,
}: {
  initial: FrameShape[]
  width: number
  height: number
  onCancel: () => void
  onDone: (shapes: FrameShape[]) => void
}) {
  const [shapes, setShapes] = useState<FrameShape[]>(initial)
  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState<string>(SHAPE_COLORS[0])
  /** 正在拖的那一笔（起点和当前点，比例坐标） */
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  /** 正在输入的文字和位置 */
  const [typing, setTyping] = useState<{ x: number; y: number; text: string } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const full = shapes.length >= SHAPES_MAX
  // Esc：正在输入文字时只取消这句，否则退出标注（不保存）。在 window 的捕获阶段先接住，
  // 不让它传到弹窗（Radix 在 document 捕获阶段听 Esc）把整个弹窗关了
  const esc = useRef(() => {})
  esc.current = () => (typing ? setTyping(null) : onCancel())
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      esc.current()
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])
  const at = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const c = (v: number) => Math.min(1, Math.max(0, v))
    return { x: c((e.clientX - r.left) / r.width), y: c((e.clientY - r.top) / r.height) }
  }
  const commitText = () => {
    if (typing?.text.trim())
      setShapes((l) => [...l, { kind: 'text', x: typing.x, y: typing.y, text: typing.text.trim(), color }])
    setTyping(null)
  }
  const shape = (d: NonNullable<typeof draft>): FrameShape | null => {
    if (tool === 'arrow') return Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01 ? null : { kind: 'arrow', ...d, color }
    const x = Math.min(d.x1, d.x2)
    const y = Math.min(d.y1, d.y2)
    const w = Math.abs(d.x2 - d.x1)
    const h = Math.abs(d.y2 - d.y1)
    return w < 0.005 || h < 0.005 ? null : { kind: 'rect', x, y, w, h, color }
  }
  const btn = (on: boolean) =>
    cn(
      'grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-white/85 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-35',
      on && 'bg-white/20 text-white',
    )
  const preview = draft ? shape(draft) : null
  return (
    <>
      <ShapesSvg
        ref={svg}
        shapes={preview ? [...shapes, preview] : shapes}
        width={width}
        height={height}
        className={cn('touch-none', tool === 'text' ? 'cursor-text' : 'cursor-crosshair')}
        onPointerDown={(e) => {
          if (full) return
          if (typing) return commitText()
          const p = at(e)
          if (tool === 'text') {
            // 不让按下的默认动作把焦点从刚出现的输入框上抢走（抢走就会马上失焦、当成没写）
            e.preventDefault()
            return setTyping({ ...p, text: '' })
          }
          e.currentTarget.setPointerCapture(e.pointerId)
          setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
        }}
        onPointerMove={(e) => draft && setDraft({ ...draft, x2: at(e).x, y2: at(e).y })}
        onPointerUp={() => {
          const s = draft && shape(draft)
          if (s) setShapes((l) => [...l, s])
          setDraft(null)
        }}
      />
      {typing && (
        <input
          ref={(el) => {
            if (el && document.activeElement !== el) requestAnimationFrame(() => el.focus())
          }}
          value={typing.text}
          maxLength={200}
          placeholder={t('写一句备注，回车确定')}
          onChange={(e) => setTyping({ ...typing, text: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitText()
          }}
          onBlur={commitText}
          style={{ left: `${typing.x * 100}%`, top: `${typing.y * 100}%`, color }}
          className="absolute z-20 w-56 rounded-md border border-white/40 bg-black/80 px-2 py-1 text-body font-semibold outline-none placeholder:font-normal placeholder:text-white/50"
        />
      )}
      {/* 工具栏：浮在画面上方正中 */}
      <div
        className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-black/75 p-1 shadow-lg backdrop-blur"
        role="toolbar"
        aria-label={t('标注工具')}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={btn(tool === 'rect')}
          aria-pressed={tool === 'rect'}
          onClick={() => setTool('rect')}
          title={t('框')}
          aria-label={t('框')}
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={btn(tool === 'arrow')}
          aria-pressed={tool === 'arrow'}
          onClick={() => setTool('arrow')}
          title={t('箭头')}
          aria-label={t('箭头')}
        >
          <ArrowUpRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={btn(tool === 'text')}
          aria-pressed={tool === 'text'}
          onClick={() => setTool('text')}
          title={t('文字备注')}
          aria-label={t('文字备注')}
        >
          <Type className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
        {SHAPE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            aria-label={t('颜色 {c}', { c })}
            aria-pressed={color === c}
            className={cn(
              'grid h-8 w-8 cursor-pointer place-items-center rounded-lg hover:bg-white/15',
              color === c && 'bg-white/20',
            )}
          >
            <span className="h-4 w-4 rounded-full border-2 border-white/80" style={{ background: c }} />
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
        <button
          type="button"
          className={btn(false)}
          disabled={!shapes.length}
          onClick={() => setShapes((l) => l.slice(0, -1))}
          title={t('撤销')}
          aria-label={t('撤销')}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={btn(false)}
          disabled={!shapes.length}
          onClick={() => setShapes([])}
          title={t('清空标注')}
          aria-label={t('清空标注')}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
        <button type="button" className={btn(false)} onClick={onCancel} title={t('取消')} aria-label={t('取消')}>
          <X className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            commitText()
            onDone(
              typing?.text.trim()
                ? [...shapes, { kind: 'text', x: typing.x, y: typing.y, text: typing.text.trim(), color }]
                : shapes,
            )
          }}
          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg bg-white px-3 text-footnote font-medium text-black hover:opacity-90"
        >
          <Check className="h-3.5 w-3.5" />
          {t('完成')}
        </button>
      </div>
    </>
  )
}

/** 把标注画到底图上，导出 PNG 的 data URL（发送时发这张）；底图读不出来时抛错 */
export async function renderAnnotated(src: string, shapes: FrameShape[]): Promise<string> {
  const img = new Image()
  img.src = src
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')!
  g.drawImage(img, 0, 0)
  const sw = strokeOf(w)
  const fs = fontOf(w)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const s of shapes) {
    g.strokeStyle = s.color
    g.fillStyle = s.color
    g.lineWidth = sw * 1.5
    if (s.kind === 'rect') g.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h)
    else if (s.kind === 'arrow') {
      const [x1, y1, x2, y2] = [s.x1 * w, s.y1 * h, s.x2 * w, s.y2 * h]
      g.beginPath()
      g.moveTo(x1, y1)
      g.lineTo(x2, y2)
      g.stroke()
      const [a, b] = arrowHead(x1, y1, x2, y2, sw * 7)
      g.beginPath()
      g.moveTo(x2, y2)
      g.lineTo(a[0], a[1])
      g.lineTo(b[0], b[1])
      g.closePath()
      g.fill()
    } else {
      g.font = `600 ${fs}px system-ui, sans-serif`
      const tw = g.measureText(s.text).width
      g.fillStyle = 'rgba(0,0,0,0.72)'
      g.fillRect(s.x * w, s.y * h, Math.min(w - s.x * w, tw + fs * 0.8), fs * 1.5)
      g.fillStyle = s.color
      g.fillText(s.text, s.x * w + fs * 0.4, s.y * h + fs * 1.08)
    }
  }
  return canvas.toDataURL('image/png')
}
