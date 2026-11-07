import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { ELEMENT_KINDS, type Box, type ElementKind, type RestoreElement } from '@shared/restore/schema'
import { KIND_COLOR } from '@shared/restore/overlay'
import { kindPrefix } from '@shared/restore/detect'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'

/**
 * 拆解这一步的图：原画上画出每个元素的框（颜色按类型，把握低的虚线），点选、拖动、拖右下角改大小，
 * 「加框」后在空白处拖一下画新的。坐标一律是原画像素：SVG 的 viewBox 就是原画尺寸，缩放交给浏览器
 */

export const kindColor = (k: ElementKind) => `rgb(${KIND_COLOR[k].join(' ')})`

export const KIND_LABEL: Record<ElementKind, () => string> = {
  background: () => t('背景'),
  panel: () => t('面板'),
  button: () => t('按钮'),
  slot: () => t('格子'),
  icon: () => t('图标'),
  text: () => t('文字'),
  bar: () => t('条'),
  input: () => t('输入框'),
  decoration: () => t('装饰'),
  other: () => t('其他'),
}

/** 原画按比例放进容器（留 16px 边）：容器变大小时跟着变 */
export function useFit(ref: React.RefObject<HTMLElement | null>, w: number, h: number) {
  const [fit, setFit] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const cw = Math.max(0, el.clientWidth - 32)
      const ch = Math.max(0, el.clientHeight - 32)
      const k = Math.min(cw / w, ch / h)
      setFit({ w: Math.floor(w * k), h: Math.floor(h * k) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, w, h])
  return fit
}

type Drag = { id: string; mode: 'move' | 'size' | 'new'; x0: number; y0: number; box: Box }

export function ElementEditor({
  url,
  width,
  height,
  elements,
  selected,
  onSelect,
  onChange,
  readOnly,
}: {
  url: string
  width: number
  height: number
  elements: RestoreElement[]
  selected: string
  onSelect: (id: string) => void
  /** commit：松手时为 true（存到服务端），拖动过程中只改本地 */
  onChange: (list: RestoreElement[], commit: boolean) => void
  readOnly?: boolean
}) {
  const svg = useRef<SVGSVGElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const fit = useFit(box, width, height)
  const [drag, setDrag] = useState<Drag>()
  const [adding, setAdding] = useState(false)
  // 大的先画、小的后画：小框叠在大框上面，点得到
  const list = elements
    .filter((e) => !e.hidden && e.kind !== 'background')
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
  const latest = useRef(elements)
  latest.current = elements

  const toArt = (ev: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((ev.clientX - r.left) / r.width) * width, y: ((ev.clientY - r.top) / r.height) * height }
  }
  const setBox = (id: string, box: Box, commit: boolean) =>
    onChange(
      latest.current.map((e) => (e.id === id ? { ...e, box, source: 'user' as const, confidence: 1 } : e)),
      commit,
    )

  useEffect(() => {
    if (!drag) return
    const move = (ev: PointerEvent) => {
      const p = toArt(ev)
      const dx = p.x - drag.x0
      const dy = p.y - drag.y0
      const b = drag.box
      const box =
        drag.mode === 'move'
          ? { ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) }
          : { ...b, w: Math.max(4, Math.round(b.w + dx)), h: Math.max(4, Math.round(b.h + dy)) }
      setBox(drag.id, box, false)
    }
    const up = () => {
      const cur = latest.current.find((e) => e.id === drag.id)
      if (cur) setBox(drag.id, cur.box, true)
      setDrag(undefined)
      if (drag.mode === 'new') setAdding(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 只在开始拖动时挂一次，拖动中用 ref 读最新的元素
  }, [drag])

  // Delete 删掉选中的框（标成 hidden：重新检测也不再出现）
  useEffect(() => {
    if (readOnly) return
    const key = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName
      if (!selected || tag === 'INPUT' || tag === 'TEXTAREA') return
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault()
        onChange(
          latest.current.map((e) => (e.id === selected ? { ...e, hidden: true } : e)),
          true,
        )
        onSelect('')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [selected, readOnly, onChange, onSelect])

  return (
    <div ref={box} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas p-4">
      {!readOnly && (
        <div className="absolute top-2 left-2 z-10 flex gap-1">
          <Button
            size="sm"
            variant={adding ? 'primary' : 'on-canvas'}
            onClick={() => setAdding((v) => !v)}
            title={t('在图上拖一下框出漏掉的元素')}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('加框')}
          </Button>
        </div>
      )}
      <div className="relative" style={{ width: fit.w, height: fit.h }}>
        <img src={url} alt={t('原画')} className="absolute inset-0 h-full w-full select-none" draggable={false} />
        <svg
          ref={svg}
          data-restore-boxes
          viewBox={`0 0 ${width} ${height}`}
          className={cn('absolute inset-0 h-full w-full', adding && 'cursor-crosshair')}
          onPointerDown={(ev) => {
            if (readOnly) return
            if (!adding) return onSelect('')
            const p = toArt(ev)
            const id = `u${Date.now().toString(36)}`
            const box = { x: Math.round(p.x), y: Math.round(p.y), w: 4, h: 4 }
            onChange([...latest.current, { id, kind: 'other', name: '', box, confidence: 1, source: 'user' }], false)
            onSelect(id)
            setDrag({ id, mode: 'new', x0: p.x, y0: p.y, box })
          }}
        >
          {list.map((e) => {
            const on = e.id === selected
            const c = kindColor(e.kind)
            const sw = Math.max(1.5, width / 700)
            return (
              <g key={e.id} data-element={e.id} data-kind={e.kind}>
                <rect
                  x={e.box.x}
                  y={e.box.y}
                  width={e.box.w}
                  height={e.box.h}
                  fill={on ? c : 'transparent'}
                  fillOpacity={on ? 0.15 : 0}
                  stroke={e.confidence < 0.6 ? 'rgb(250 204 21)' : c}
                  strokeWidth={on ? sw * 1.8 : sw}
                  strokeDasharray={e.confidence < 0.6 ? `${sw * 3} ${sw * 2}` : undefined}
                  className={cn(!readOnly && 'cursor-move')}
                  style={{ pointerEvents: adding ? 'none' : 'all' }}
                  onPointerDown={(ev) => {
                    ev.stopPropagation()
                    onSelect(e.id)
                    if (readOnly) return
                    const p = toArt(ev)
                    setDrag({ id: e.id, mode: 'move', x0: p.x, y0: p.y, box: e.box })
                  }}
                >
                  <title>{`${e.name || KIND_LABEL[e.kind]()} ${Math.round(e.box.w)}×${Math.round(e.box.h)}`}</title>
                </rect>
                {on && !readOnly && (
                  <rect
                    x={e.box.x + e.box.w - sw * 3}
                    y={e.box.y + e.box.h - sw * 3}
                    width={sw * 6}
                    height={sw * 6}
                    fill="white"
                    stroke={c}
                    strokeWidth={sw}
                    className="cursor-nwse-resize"
                    onPointerDown={(ev) => {
                      ev.stopPropagation()
                      const p = toArt(ev)
                      setDrag({ id: e.id, mode: 'size', x0: p.x, y0: p.y, box: e.box })
                    }}
                  />
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

/** 选中元素的属性：类型、名字、文字内容；删掉 */
export function ElementInspector({
  element,
  onChange,
  readOnly,
}: {
  element: RestoreElement
  onChange: (e: RestoreElement | undefined) => void
  readOnly?: boolean
}) {
  const [name, setName] = useState(element.name)
  const [text, setText] = useState(element.text?.content ?? '')
  useEffect(() => {
    setName(element.name)
    setText(element.text?.content ?? '')
  }, [element.id, element.name, element.text?.content])
  const b = element.box
  const save = (patch: Partial<RestoreElement>) => onChange({ ...element, ...patch, source: 'user' })
  return (
    <div data-restore-inspector className="flex flex-col gap-2 border-t p-3">
      <div className="flex items-center gap-2 text-caption text-subtle tabular-nums">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: kindColor(element.kind) }} />
        {Math.round(b.x)}, {Math.round(b.y)} · {Math.round(b.w)}×{Math.round(b.h)}
        {element.repeat && <span>· {t('重复组')}</span>}
        <span className="flex-1" />
        {!readOnly && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('删掉这个框')}
            title={t('删掉这个框')}
            onClick={() => onChange(undefined)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <Select
        size="sm"
        aria-label={t('类型')}
        disabled={readOnly}
        value={element.kind}
        onChange={(ev) => {
          const kind = ev.target.value as ElementKind
          save({
            kind,
            ...(kind === 'text' && !element.text
              ? { text: { content: '', px: Math.round(b.h), color: '#FFFFFFFF', align: 'left', bold: false } }
              : {}),
          })
        }}
        options={ELEMENT_KINDS.filter((k) => k !== 'background').map((k) => ({ value: k, label: KIND_LABEL[k]() }))}
      />
      <Input
        size="sm"
        aria-label={t('控件名')}
        disabled={readOnly}
        value={name}
        placeholder={`${kindPrefix(element.kind)}_Name`}
        onChange={(ev) => setName(ev.target.value)}
        onBlur={() => name !== element.name && save({ name: name.trim().replace(/[^\w]/g, '_') })}
      />
      {element.kind === 'text' && (
        <Input
          size="sm"
          aria-label={t('文字内容')}
          disabled={readOnly}
          value={text}
          placeholder={t('照原画写上文字')}
          onChange={(ev) => setText(ev.target.value)}
          onBlur={() =>
            text !== (element.text?.content ?? '') &&
            save({
              text: {
                px: Math.round(b.h),
                color: '#FFFFFFFF',
                align: 'left',
                bold: false,
                ...element.text,
                content: text,
              },
            })
          }
        />
      )}
    </div>
  )
}
