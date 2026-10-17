import { useEffect, useRef, useState } from 'react'
import {
  Eye,
  EyeOff,
  Hand,
  MapPin,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Square,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { ANNOTATION_KINDS, annotationBox, type Annotation, type AnnotationKind } from '@shared/design'
import { walk, type Widget } from '@shared/umg'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/**
 * 标注：在效果图上框选、画箭头、圈画、打点，标出要改的地方，再在 AI 对话里一起发出去。
 * 颜色表示意思：红色修改、蓝色新增、橙色删除、绿色保持不变。
 */
export type Tool = 'select' | 'hand' | 'rect' | 'arrow' | 'pen' | 'pin'

export const KIND_COLOR: Record<AnnotationKind, string> = {
  change: '#f43f5e',
  add: '#3b82f6',
  remove: '#f59e0b',
  keep: '#22c55e',
}
export const kindLabel = (k: AnnotationKind) =>
  ({ change: t('修改'), add: t('新增'), remove: t('删除'), keep: t('保持不变') })[k]
const KIND_HINT: Record<AnnotationKind, string> = {
  change: t('这里要改'),
  add: t('在这里加东西'),
  remove: t('把这里去掉'),
  keep: t('这部分别动，可以当参考'),
}

const TOOLS: { id: Tool; icon: LucideIcon; label: string; key: string }[] = [
  { id: 'select', icon: MousePointer2, label: t('选择'), key: 'V' },
  { id: 'hand', icon: Hand, label: t('拖动画布'), key: 'H' },
  { id: 'rect', icon: Square, label: t('框选标注'), key: 'R' },
  { id: 'arrow', icon: MoveUpRight, label: t('箭头标注'), key: 'A' },
  { id: 'pen', icon: PenLine, label: t('画笔标注'), key: 'P' },
  { id: 'pin', icon: MapPin, label: t('打点标注'), key: 'T' },
]
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(TOOLS.map((x) => [x.key.toLowerCase(), x.id]))
export const isMarkTool = (tool: Tool) => tool !== 'select' && tool !== 'hand'

/** 效果区上方的工具栏 */
export function AnnotationToolbar({
  tool,
  onTool,
  kind,
  onKind,
  count,
  visible,
  onToggleVisible,
  onClear,
}: {
  tool: Tool
  onTool: (t: Tool) => void
  kind: AnnotationKind
  onKind: (k: AnnotationKind) => void
  count: number
  visible: boolean
  onToggleVisible: () => void
  onClear: () => void
}) {
  return (
    <div
      role="toolbar"
      aria-label={t('标注工具')}
      className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-white/10 bg-[#232326]/95 p-1 text-white/70 shadow-pop backdrop-blur"
    >
      {TOOLS.map((x, i) => (
        <span key={x.id} className="flex items-center">
          {i === 2 && <Sep />}
          <ToolButton label={`${x.label} (${x.key})`} on={tool === x.id} onClick={() => onTool(x.id)}>
            <x.icon className="h-4 w-4" strokeWidth={1.8} />
          </ToolButton>
        </span>
      ))}
      <Sep />
      <div role="radiogroup" aria-label={t('标注的意思')} className="flex items-center gap-0.5 px-0.5">
        {ANNOTATION_KINDS.map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            aria-label={kindLabel(k)}
            onClick={() => onKind(k)}
            title={`${kindLabel(k)}：${KIND_HINT[k]}`}
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:text-white',
              kind === k && 'bg-white/10 text-white',
            )}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[k] }} />
            {/* 只给选中的写字，工具栏在窄的效果区里也放得下 */}
            {kind === k && <span className="whitespace-nowrap">{kindLabel(k)}</span>}
          </button>
        ))}
      </div>
      {count > 0 && (
        <>
          <Sep />
          <ToolButton label={visible ? t('隐藏标注') : t('显示标注')} onClick={onToggleVisible}>
            {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </ToolButton>
          <ToolButton label={t('清除所有标注')} onClick={onClear}>
            <Trash2 className="h-4 w-4" />
          </ToolButton>
        </>
      )}
    </div>
  )
}

const Sep = () => <span className="mx-1 h-5 w-px bg-white/10" />

function ToolButton({
  label,
  on,
  onClick,
  children,
}: {
  label: string
  on?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={cn(
        'grid h-7 w-7 cursor-pointer place-items-center rounded-lg transition-colors hover:bg-white/8 hover:text-white',
        on && 'bg-[#4c9bff]/20 text-[#7cb6ff]',
      )}
    >
      {children}
    </button>
  )
}

/** 标注范围里的控件名：框选取大部分落在框里的控件，点和箭头取指到的最里层控件 */
export function widgetsIn(stage: HTMLElement, scale: number, root: Widget, a: Pick<Annotation, 'shape' | 'points'>) {
  const names = new Map<string, string>()
  walk(root, (w) => void names.set(w.id, w.Name))
  const s = stage.getBoundingClientRect()
  const els = [...stage.querySelectorAll<HTMLElement>('[data-wid]')]
    .filter((el) => el.dataset.wid !== root.id && names.has(el.dataset.wid!))
    .map((el) => {
      const r = el.getBoundingClientRect()
      return {
        id: el.dataset.wid!,
        x: (r.left - s.left) / scale,
        y: (r.top - s.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      }
    })
    .filter((r) => r.w > 0 && r.h > 0)
  const b = annotationBox(a)
  let hit: typeof els
  if (b.w > 4 && b.h > 4) {
    hit = els.filter((r) => {
      const ix = Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x))
      const iy = Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y))
      return (ix * iy) / (r.w * r.h) >= 0.6
    })
    // 框比所有控件都小：取包含框中心的最小控件
    if (!hit.length) hit = containing(els, b.x + b.w / 2, b.y + b.h / 2).slice(0, 1)
  } else hit = containing(els, b.x, b.y).slice(0, 2)
  return [...new Set(hit.map((r) => names.get(r.id)!))].slice(0, 12)
}

function containing<T extends { x: number; y: number; w: number; h: number }>(els: T[], x: number, y: number) {
  return els
    .filter((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)
}

/**
 * 标注层：盖在效果图上，坐标是设计稿像素。画图工具下拖动新建标注；选择工具下点编号可以写说明、改意思、删掉。
 */
export function AnnotationLayer({
  size,
  scale,
  tool,
  kind,
  list,
  visible,
  active,
  onActive,
  onCreate,
  onChange,
  onRemove,
}: {
  size: { X: number; Y: number }
  scale: number
  tool: Tool
  kind: AnnotationKind
  list: Annotation[]
  visible: boolean
  active: string
  onActive: (id: string) => void
  onCreate: (a: Pick<Annotation, 'shape' | 'points' | 'kind'>) => void
  onChange: (a: Annotation) => void
  onRemove: (id: string) => void
}) {
  const [draft, setDraft] = useState<Pick<Annotation, 'shape' | 'points' | 'kind'> | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const drawing = isMarkTool(tool)

  const toDesign = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect()
    const c = (v: number, max: number) => Math.round(Math.max(0, Math.min(max, v)))
    return [c((e.clientX - r.left) / scale, size.X), c((e.clientY - r.top) / scale, size.Y)]
  }

  const start = (e: React.PointerEvent) => {
    if (!drawing || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const [x, y] = toDesign(e)
    if (tool === 'pin') {
      onCreate({ shape: 'pin', points: [x, y], kind })
      return
    }
    const shape = tool as 'rect' | 'arrow' | 'pen'
    let cur: Pick<Annotation, 'shape' | 'points' | 'kind'> = {
      shape,
      kind,
      points: shape === 'rect' ? [x, y, 0, 0] : shape === 'arrow' ? [x, y, x, y] : [x, y],
    }
    setDraft(cur)
    const move = (ev: PointerEvent) => {
      const [mx, my] = toDesign(ev)
      if (shape === 'rect')
        cur = { ...cur, points: [Math.min(x, mx), Math.min(y, my), Math.abs(mx - x), Math.abs(my - y)] }
      else if (shape === 'arrow') cur = { ...cur, points: [x, y, mx, my] }
      else {
        const p = cur.points
        // 点太密时跳过，画笔数据不会太大
        if (Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]) < 3 / scale) return
        cur = { ...cur, points: [...p, mx, my] }
      }
      setDraft(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
      const b = annotationBox(cur)
      const tiny =
        shape === 'rect'
          ? b.w < 6 || b.h < 6
          : shape === 'arrow'
            ? Math.hypot(cur.points[2] - cur.points[0], cur.points[3] - cur.points[1]) < 10
            : cur.points.length < 6
      if (!tiny) onCreate(cur)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const shown = visible ? list : []
  const editing = shown.find((a) => a.id === active)
  return (
    <div
      ref={layer}
      onPointerDown={start}
      className={cn('absolute inset-0', drawing ? 'cursor-crosshair' : 'pointer-events-none')}
    >
      <svg
        viewBox={`0 0 ${size.X} ${size.Y}`}
        width={size.X * scale}
        height={size.Y * scale}
        className="pointer-events-none absolute inset-0 overflow-visible"
      >
        <defs>
          {Object.entries(KIND_COLOR).map(([k, c]) => (
            <marker
              key={k}
              id={`ann-head-${k}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {shown.map((a) => (
          <Shape key={a.id} a={a} scale={scale} on={a.id === active} />
        ))}
        {draft && <Shape a={draft} scale={scale} on />}
      </svg>
      {shown.map((a, i) => {
        const b = annotationBox(a)
        const [x, y] = a.shape === 'arrow' ? [a.points[0], a.points[1]] : [b.x, b.y]
        return (
          <button
            key={a.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onActive(a.id === active ? '' : a.id)
            }}
            title={a.note || kindLabel(a.kind)}
            aria-label={t('标注 {n}', { n: i + 1 })}
            style={{ left: x * scale, top: y * scale, background: KIND_COLOR[a.kind] }}
            className={cn(
              'pointer-events-auto absolute z-10 grid h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full px-1 font-mono text-[11px] font-semibold text-white shadow-[0_1px_4px_rgba(0,0,0,0.5)] ring-2 ring-white/90',
              a.id === active && 'ring-[3px]',
            )}
          >
            {i + 1}
          </button>
        )
      })}
      {editing && (
        <AnnotationEditor
          key={editing.id}
          a={editing}
          index={shown.indexOf(editing) + 1}
          scale={scale}
          size={size}
          onChange={onChange}
          onRemove={() => onRemove(editing.id)}
          onClose={() => onActive('')}
        />
      )}
    </div>
  )
}

function Shape({ a, scale, on }: { a: Pick<Annotation, 'shape' | 'points' | 'kind'>; scale: number; on: boolean }) {
  const c = KIND_COLOR[a.kind]
  // 线宽按屏幕像素算，缩放后不会变粗变细
  const sw = (on ? 3 : 2.25) / scale
  const p = a.points
  if (a.shape === 'rect')
    return (
      <rect
        x={p[0]}
        y={p[1]}
        width={p[2]}
        height={p[3]}
        rx={4 / scale}
        fill={c}
        fillOpacity={0.12}
        stroke={c}
        strokeWidth={sw}
      />
    )
  if (a.shape === 'arrow')
    return (
      <line
        x1={p[0]}
        y1={p[1]}
        x2={p[2]}
        y2={p[3]}
        stroke={c}
        strokeWidth={sw}
        strokeLinecap="round"
        markerEnd={`url(#ann-head-${a.kind})`}
      />
    )
  if (a.shape === 'pen')
    return (
      <polyline
        points={p.join(' ')}
        fill="none"
        stroke={c}
        strokeWidth={sw * 1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  return <circle cx={p[0]} cy={p[1]} r={14 / scale} fill={c} fillOpacity={0.18} stroke={c} strokeWidth={sw} />
}

/** 选中一个标注时旁边弹出的小卡片：写说明、改意思、删除 */
function AnnotationEditor({
  a,
  index,
  scale,
  size,
  onChange,
  onRemove,
  onClose,
}: {
  a: Annotation
  index: number
  scale: number
  size: { X: number; Y: number }
  onChange: (a: Annotation) => void
  onRemove: () => void
  onClose: () => void
}) {
  const b = annotationBox(a)
  const W = 260
  // 放在标注右边，放不下就放左边；纵向不超出效果图
  const right = (b.x + b.w) * scale + 14
  const left = right + W > size.X * scale ? Math.max(4, b.x * scale - W - 14) : right
  const top = Math.max(4, Math.min(b.y * scale, size.Y * scale - 190))
  const [note, setNote] = useState(a.note)
  useEffect(() => setNote(a.note), [a.note])
  const commit = () => note !== a.note && onChange({ ...a, note })
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{ left, top, width: W }}
      className="pointer-events-auto absolute z-20 rounded-xl border border-line-strong bg-card p-3 text-fg shadow-pop"
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="grid h-5 min-w-5 place-items-center rounded-full px-1 font-mono text-[11px] font-semibold text-white"
          style={{ background: KIND_COLOR[a.kind] }}
        >
          {index}
        </span>
        <span className="flex-1 truncate text-[12px] text-muted">
          {a.widgets.length ? a.widgets.join('、') : t('没有对上具体的控件')}
        </span>
        <button
          onClick={onClose}
          aria-label={t('关闭')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mb-2 grid grid-cols-4 gap-1">
        {ANNOTATION_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => onChange({ ...a, note, kind: k })}
            title={KIND_HINT[k]}
            className={cn(
              'flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border text-[11.5px]',
              a.kind === k ? 'border-transparent text-white' : 'text-muted hover:bg-sel',
            )}
            style={a.kind === k ? { background: KIND_COLOR[k] } : undefined}
          >
            {kindLabel(k)}
          </button>
        ))}
      </div>
      <textarea
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            commit()
            onClose()
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            commit()
            onClose()
          }
        }}
        rows={3}
        placeholder={t('说明要怎么改，例如：按钮换成金色描边')}
        aria-label={t('标注说明')}
        className="block w-full resize-none rounded-lg border bg-field px-2.5 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-subtle focus:border-accent"
      />
      <div className="mt-2 flex items-center">
        <button
          onClick={onRemove}
          className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-subtle hover:bg-sel hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('删除标注')}
        </button>
        <span className="ml-auto text-[11px] text-subtle">{t('回车保存')}</span>
      </div>
    </div>
  )
}
