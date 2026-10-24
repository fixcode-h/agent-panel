import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  Maximize,
  Minus,
  Plus,
} from 'lucide-react'
import {
  IMAGE_SLOT,
  findParent,
  findWidget,
  walk,
  type Component,
  type Margin,
  type Vec2,
  type Widget,
} from '@shared/umg'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { UmgNode, type RenderImage } from './umg-render'
import type { Annotation, AnnotationKind } from '@shared/design'
import type { DesignData } from '@shared/design-data'
import type { Device } from '@shared/web'
import { animRuntime, compileAnimations, type UiAnimation } from '@shared/anim'
import type { AnimCommand } from './AnimationPanel'
import { AnnotationLayer, AnnotationToolbar, TOOL_KEYS, isMarkTool, widgetsIn, type Tool } from './Annotations'

type Rect = { x: number; y: number; w: number; h: number }
type DragImage = { id: string; width: number; height: number; nineSlice?: Margin }

/**
 * 图片和控件大小合不合适：九宫格的图能任意拉伸；其他的宽高比差不多（30% 以内），
 * 大小在图片的 0.35 ~ 3 倍之间（再大就糊、再小就浪费）
 */
const imageFits = (img: DragImage, r: Rect) => {
  if (img.nineSlice) return true
  const aspect = Math.abs(Math.log(r.w / r.h / (img.width / img.height)))
  const k = Math.max(r.w / img.width, r.h / img.height)
  return aspect <= Math.log(1.3) && k >= 0.35 && k <= 3
}

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
  onOpen,
  extra = [],
  onPick,
  device,
  onReorder,
  onNudge,
  overlay,
  animations,
  animCommand,
  dragImage,
  onDropImage,
  data,
}: {
  /** 正在从图片列表拖过来的图：高亮能放它、大小合适的控件 */
  dragImage?: DragImage | null
  /** 在控件上松手：把图用到这个控件上 */
  onDropImage?: (id: string, imageId: string) => void
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
  /** 双击控件：用了图片的跳到图片，子控件进去编辑 */
  onOpen?: (id: string) => void
  /** 按住 Shift / Ctrl 多选的其他控件（selected 是最后点的那个） */
  extra?: string[]
  /** additive：按住 Shift / Ctrl 点的，加进多选或从多选里去掉 */
  onPick?: (id: string, additive: boolean) => void
  /** 网页 UI 按哪个宽度画 */
  device?: Device
  /** 网页 UI：把控件拖到某个 Frame 的第 index 个位置 */
  onReorder?: (id: string, parentId: string, index: number) => void
  /** 网页 UI：绝对定位的控件拖动时改偏移（dx、dy 是设计稿像素，往右、往下为正） */
  onNudge?: (id: string, dx: number, dy: number, key: string) => void
  /** 半透明盖在画布上的图（确认的原画模板），对照着调位置 */
  overlay?: string
  /** 设计里的全部动画：运行模式里按触发方式播放 */
  animations?: UiAnimation[]
  /** 动画面板的指令：停在某个时间或播放一次 */
  animCommand?: AnimCommand | null
  /** 画板的运行时假数据：列表按它渲染条目、控件按它显示状态 */
  data?: DesignData
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

  // 拖动画布：抓手工具下左键拖，任何时候中键或右键按住拖（放大后看细节时最顺手）
  const [panning, setPanning] = useState(false)
  // 右键拖过就不弹浏览器的右键菜单；只是点一下右键时照常
  const dragged = useRef(false)
  const pan = (e: React.PointerEvent) => {
    const el = wrap.current
    if (!el || !(e.button === 1 || e.button === 2 || (tool === 'hand' && e.button === 0))) return false
    e.preventDefault()
    const sx = e.clientX + el.scrollLeft
    const sy = e.clientY + el.scrollTop
    dragged.current = false
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
      if (!dragged.current) setPanning(true)
      dragged.current = true
      el.scrollLeft = sx - ev.clientX
      el.scrollTop = sy - ev.clientY
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGuides({ x: [], y: [] })
      setPanning(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return true
  }

  // 滚轮缩放：以鼠标所在的点为中心（缩放后这一点还在鼠标下面）；按住 Shift 照常滚动画布，运行模式里滚动页面内容。
  // React 的 onWheel 是被动监听，拦不住浏览器自己的缩放和滚动，所以直接挂原生事件
  const anchor = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const playRef = useRef(false)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const on = (e: WheelEvent) => {
      if (e.shiftKey || (playRef.current && !e.ctrlKey && !e.metaKey)) return
      e.preventDefault()
      const st = stage.current
      if (st) {
        const r = st.getBoundingClientRect()
        const s0 = scaleRef.current
        anchor.current = { x: (e.clientX - r.left) / s0, y: (e.clientY - r.top) / s0, cx: e.clientX, cy: e.clientY }
      }
      // 触控板的捏合缩放 deltaY 很小，按幅度缩放；鼠标滚轮一格约 10%
      const k = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) / 600)
      setZoom(Math.max(0.05, Math.min(4, scaleRef.current * k)))
    }
    el.addEventListener('wheel', on, { passive: false })
    return () => el.removeEventListener('wheel', on)
  }, [])
  // 缩放之后把记下的那一点挪回鼠标下面
  useLayoutEffect(() => {
    const a = anchor.current
    const el = wrap.current
    const st = stage.current
    if (!a || !el || !st) return
    anchor.current = null
    const r = st.getBoundingClientRect()
    el.scrollLeft += r.left + a.x * scale - a.cx
    el.scrollTop += r.top + a.y * scale - a.cy
  }, [scale])

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

  // 选中框和多选框跟着控件走。以前是每帧无条件量一次，选中一个控件后什么都不动也在跑；
  // 现在只在内容变化、滚动、拖动、缩放、动画时量几帧，连续两帧结果不变就停
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const extraRef = useRef(extra)
  extraRef.current = extra
  const frame = useRef(0)
  const [extraBoxes, setExtraBoxes] = useState<{ x: number; y: number; w: number; h: number }[]>([])
  const boxesKey = useCallback(() => {
    const st = stage.current
    const sc = scaleRef.current
    const at = (id: string, a: DOMRect) => {
      const el = st?.querySelector<HTMLElement>(`[data-wid="${CSS.escape(id)}"]`)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: (b.left - a.left) / sc,
        y: (b.top - a.top) / sc,
        w: b.width / sc,
        h: b.height / sc,
      }
    }
    if (!st) return ''
    const a = st.getBoundingClientRect()
    const id = selectedRef.current
    const next = id ? at(id, a) : null
    setBox((cur) =>
      cur &&
      next &&
      Math.abs(cur.x - next.x) + Math.abs(cur.y - next.y) + Math.abs(cur.w - next.w) + Math.abs(cur.h - next.h) < 0.5
        ? cur
        : next,
    )
    const list = extraRef.current
    const ex = list.length
      ? (list.map((x) => at(x, a)).filter(Boolean) as { x: number; y: number; w: number; h: number }[])
      : []
    setExtraBoxes((cur) => (JSON.stringify(cur) === JSON.stringify(ex) ? cur : ex))
    return `${JSON.stringify(next)}|${JSON.stringify(ex)}`
  }, [])
  const settle = useCallback(
    (holdMs = 400) => {
      cancelAnimationFrame(frame.current)
      const start = performance.now()
      let prev = ''
      let still = 0
      const tick = () => {
        const key = boxesKey()
        still = key === prev ? still + 1 : 0
        prev = key
        // 图片加载、布局变化可能在下一两帧才完成，稳定两帧后再停
        if (still < 2 && performance.now() - start < holdMs) frame.current = requestAnimationFrame(tick)
      }
      tick()
    },
    [boxesKey],
  )
  const extraKey = extra.join('|')
  useEffect(() => {
    settle()
    return () => cancelAnimationFrame(frame.current)
  }, [settle, selected, scale, extraKey, root, components, target, device])
  // 滚动（滚轮缩放后、抓手拖动、页面滚动）、容器大小变化时重新量
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const on = () => settle(250)
    el.addEventListener('scroll', on, { passive: true })
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => settle(300))
      ro.observe(el)
      if (stage.current) ro.observe(stage.current)
    }
    return () => {
      el.removeEventListener('scroll', on)
      ro?.disconnect()
    }
  }, [settle])
  // 选中的控件自己变大变小（图片加载完、文字换行）：重新量一次
  useEffect(() => {
    const el = selected ? stage.current?.querySelector<HTMLElement>(`[data-wid="${CSS.escape(selected)}"]`) : null
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => settle(200))
    ro.observe(el)
    return () => ro.disconnect()
  }, [selected, root, settle])
  // 动画面板拖播放头 / 播放时位置一直在变：这段期间继续量
  useEffect(() => {
    if (animCommand) settle(2500)
  }, [animCommand, settle])

  const parent = selected ? findParent(root, selected) : undefined
  const movable = parent?.Type === 'CanvasPanel' && !!findWidget(root, selected)?.Slot
  // 拖动时的对齐参考线（设计稿像素）
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })

  /** 控件在设计稿里的位置和大小（按页面上实际画出来的量） */
  const measure = (id: string) => {
    const st = stage.current
    const el = st?.querySelector<HTMLElement>(`[data-wid="${CSS.escape(id)}"]`)
    if (!st || !el) return undefined
    const a = st.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    return { x: (b.left - a.left) / scale, y: (b.top - a.top) / scale, w: b.width / scale, h: b.height / scale }
  }
  const multi = [selected, ...extra].filter(Boolean)
  // 多选的控件都在同一个 CanvasPanel 里时才能对齐、等间距
  const alignable =
    multi.length > 1 &&
    multi.every((id) => {
      const p = findParent(root, id)
      return p?.Type === 'CanvasPanel' && p.id === parent?.id
    })
  // 拖图片时能放的控件：能放图（Image、Border、Button、Picture、Frame…）且大小合适；按住 Alt 不看大小
  const [slots, setSlots] = useState<(Rect & { id: string; name: string; fits: boolean })[]>([])
  const [hot, setHot] = useState('')
  const [anySize, setAnySize] = useState(false)
  useEffect(() => {
    setHot('')
    setAnySize(false)
    if (!dragImage) return setSlots([])
    const out: typeof slots = []
    walk(root, (w) => {
      const r = IMAGE_SLOT[w.Type] && measure(w.id)
      if (r && r.w >= 4 && r.h >= 4) out.push({ ...r, id: w.id, name: w.Name, fits: imageFits(dragImage, r) })
    })
    setSlots(out)
    // measure 每次渲染都是新的函数，只在开始拖、树或缩放变化时重新量
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [dragImage, root, scale])
  const shownSlots = slots.filter((r) => r.fits || anySize)
  /** 指针下最小的那个能放的控件（嵌套时取最里面的） */
  const slotAt = (e: React.DragEvent, any: boolean) => {
    const st = stage.current
    if (!st) return undefined
    const a = st.getBoundingClientRect()
    const x = (e.clientX - a.left) / scale
    const y = (e.clientY - a.top) / scale
    return slots
      .filter((r) => (r.fits || any) && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
      .sort((p, q) => p.w * p.h - q.w * q.h)[0]
  }

  /** 对齐、等间距：按量到的位置算出每个控件要挪多少，一次挪完（撤销时一起退回） */
  const align = (how: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hspace' | 'vspace') => {
    const items = multi.map((id) => ({ id, b: measure(id)! })).filter((x) => x.b)
    if (items.length < 2) return
    const key = `align:${Date.now()}`
    const minX = Math.min(...items.map((x) => x.b.x))
    const maxX = Math.max(...items.map((x) => x.b.x + x.b.w))
    const minY = Math.min(...items.map((x) => x.b.y))
    const maxY = Math.max(...items.map((x) => x.b.y + x.b.h))
    const moves = new Map<string, { dx: number; dy: number }>()
    for (const { id, b } of items) {
      const dx =
        how === 'left'
          ? minX - b.x
          : how === 'right'
            ? maxX - b.x - b.w
            : how === 'hcenter'
              ? (minX + maxX) / 2 - b.x - b.w / 2
              : 0
      const dy =
        how === 'top'
          ? minY - b.y
          : how === 'bottom'
            ? maxY - b.y - b.h
            : how === 'vcenter'
              ? (minY + maxY) / 2 - b.y - b.h / 2
              : 0
      moves.set(id, { dx, dy })
    }
    if (how === 'hspace' || how === 'vspace') {
      const h = how === 'hspace'
      const sorted = [...items].sort((a, b) => (h ? a.b.x - b.b.x : a.b.y - b.b.y))
      const total = sorted.reduce((n, x) => n + (h ? x.b.w : x.b.h), 0)
      const gap = ((h ? maxX - minX : maxY - minY) - total) / (sorted.length - 1)
      let at = h ? minX : minY
      for (const x of sorted) {
        moves.set(x.id, h ? { dx: at - x.b.x, dy: 0 } : { dx: 0, dy: at - x.b.y })
        at += (h ? x.b.w : x.b.h) + gap
      }
    }
    for (const [id, m] of moves) {
      const dx = Math.round(m.dx)
      const dy = Math.round(m.dy)
      if (dx || dy) onMove(id, { dx, dy, mode: 'move' }, key)
    }
  }

  // 网页 UI 拖动换位置时插入的位置（设计稿像素的一条线）
  const [dropLine, setDropLine] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  /**
   * 网页 UI 里拖动选中的控件：跟着自动布局走的，松手时放到鼠标下面那个 Frame 里对应的位置；
   * 绝对定位的，直接改偏移
   */
  const webDrag = (e: React.PointerEvent) => {
    const st = stage.current
    const me = st?.querySelector<HTMLElement>(`[data-wid="${CSS.escape(selected)}"]`)
    const w = findWidget(root, selected)
    if (!st || !me || !w || !parent || !onReorder) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    const abs = w.Slot?.Position === 'absolute'
    const key = `drag:${selected}:${Date.now()}`
    let lx = 0
    let ly = 0
    let target: { parent: string; index: number } | null = null
    let started = false
    const toDesign = (r: DOMRect) => {
      const a = st.getBoundingClientRect()
      return { x: (r.left - a.left) / scale, y: (r.top - a.top) / scale, w: r.width / scale, h: r.height / scale }
    }
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      started = true
      if (abs) {
        const dx = Math.round((ev.clientX - sx) / scale)
        const dy = Math.round((ev.clientY - sy) / scale)
        if (dx !== lx || dy !== ly) onNudge?.(selected, dx - lx, dy - ly, key)
        lx = dx
        ly = dy
        return
      }
      // 鼠标下面最近的、不是自己（也不在自己里面）的 Frame
      const frame = document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .find(
          (el): el is HTMLElement =>
            el instanceof HTMLElement && el.dataset.type === 'Frame' && !!el.dataset.wid && !me.contains(el),
        )
      if (!frame) {
        target = null
        setDropLine(null)
        return
      }
      const row = getComputedStyle(frame).flexDirection.startsWith('row')
      const kids = [...frame.children].filter(
        (c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.wid && c !== me,
      )
      let index = kids.length
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect()
        if (row ? ev.clientX < r.left + r.width / 2 : ev.clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      // 插入线：在第 index 个控件前面，放到最后时在最后一个后面
      const fr = toDesign(frame.getBoundingClientRect())
      const ref = kids[index] ?? kids[index - 1]
      const rr = ref ? toDesign(ref.getBoundingClientRect()) : undefined
      const before = !!kids[index]
      const line = rr
        ? row
          ? { x: before ? rr.x - 1 : rr.x + rr.w - 1, y: rr.y, w: 2, h: rr.h }
          : { x: rr.x, y: before ? rr.y - 1 : rr.y + rr.h - 1, w: rr.w, h: 2 }
        : { x: fr.x + 4, y: fr.y + 4, w: row ? 2 : fr.w - 8, h: row ? fr.h - 8 : 2 }
      setDropLine(line)
      // 控件树里的位置：自己原来在这个 Frame 里时，前面的位置要把自己算进去
      const all = [...frame.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.wid)
      const realIndex = kids[index] ? all.indexOf(kids[index]) : all.length
      target = { parent: frame.dataset.wid!, index: realIndex }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDropLine(null)
      if (started && target) onReorder(selected, target.parent, target.index)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const drag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    if (!movable) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sy = e.clientY
    let lx = 0
    let ly = 0
    const key = `${mode}:${selected}:${Date.now()}`
    // 吸附：自己的左、中、右（上、中、下）边靠近父控件或同级控件的边和中线时贴上去，按住 Alt 不吸附
    const me = measure(selected)
    const refs = [parent!.id, ...(parent!.Children ?? []).map((c) => c.id).filter((id) => id !== selected)]
      .map((id) => ({ b: measure(id) }))
      .filter((x) => x.b) as { b: { x: number; y: number; w: number; h: number } }[]
    const lines = (axis: 'x' | 'y') =>
      refs.flatMap(({ b }) => {
        const [p, l] = axis === 'x' ? [b.x, b.w] : [b.y, b.h]
        return [p, p + l / 2, p + l]
      })
    const tx = lines('x')
    const ty = lines('y')
    const snap = (edges: number[], targets: number[]) => {
      const th = 6 / scale
      let best: { d: number; at: number } | undefined
      for (const ed of edges)
        for (const tg of targets) {
          const d = tg - ed
          if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: tg }
        }
      return best
    }
    const move = (ev: PointerEvent) => {
      let dx = Math.round((ev.clientX - sx) / scale)
      let dy = Math.round((ev.clientY - sy) / scale)
      const gx: number[] = []
      const gy: number[] = []
      if (me && !ev.altKey) {
        const ex = mode === 'move' ? [me.x + dx, me.x + me.w / 2 + dx, me.x + me.w + dx] : [me.x + me.w + dx]
        const ey = mode === 'move' ? [me.y + dy, me.y + me.h / 2 + dy, me.y + me.h + dy] : [me.y + me.h + dy]
        const bx = snap(ex, tx)
        const by = snap(ey, ty)
        if (bx) {
          dx = Math.round(dx + bx.d)
          gx.push(bx.at)
        }
        if (by) {
          dy = Math.round(dy + by.d)
          gy.push(by.at)
        }
      }
      setGuides({ x: gx, y: gy })
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
  playRef.current = play
  const ctx = {
    images,
    components: new Map(components.map((c) => [c.Name, c])),
    interactive: true,
    depth: 0,
    play,
    device,
    tree: target,
    data,
  }

  // 动画：运行模式里按触发方式自动播放（打开时、悬停、点击、滚动到可见）；平时只在动画面板拖播放头、点播放时动
  const runs = useMemo(() => compileAnimations(animations ?? []), [animations])
  useEffect(() => {
    const el = stage.current
    if (!play || !el || !runs.length) return
    const ctl = animRuntime(el, runs, { rootTree: target, triggers: true })
    return () => ctl.dispose()
  }, [play, runs, target, root, components, device])
  useEffect(() => {
    const el = stage.current
    if (play || !el || !animCommand) return
    const ctl = animRuntime(el, runs, { rootTree: target })
    if (animCommand.play) ctl.play(animCommand.name, { tree: animCommand.tree })
    else ctl.seek(animCommand.name, animCommand.ms, animCommand.tree)
    return () => ctl.dispose()
  }, [play, runs, target, root, components, device, animCommand])

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#18181a]">
      {dragImage && !play && onDropImage && (
        <div className="pointer-events-none absolute top-14 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-[0.75rem] whitespace-nowrap text-white/85">
          {slots.some((r) => r.fits)
            ? t('拖到绿框的控件上松手即可用上；按住 Alt 显示所有能放图的控件')
            : slots.length
              ? t('没有大小合适的控件；按住 Alt 可以放到任意能放图的控件上')
              : t('当前界面里没有能放图片的控件')}
        </div>
      )}
      <div
        ref={wrap}
        className={cn(
          'relative min-h-0 flex-1 overflow-auto',
          tool === 'hand' && 'cursor-grab active:cursor-grabbing',
          panning && 'cursor-grabbing [&_*]:cursor-grabbing!',
        )}
        onPointerDownCapture={(e) => {
          if (pan(e)) e.stopPropagation()
        }}
        onContextMenu={(e) => {
          if (!dragged.current) return
          e.preventDefault()
          dragged.current = false
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect('')
        }}
      >
        <div
          className="grid min-h-full min-w-full place-items-center px-6 pt-16 pb-12"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onSelect('')
          }}
        >
          <div
            style={{ width: size.X * scale, height: size.Y * scale }}
            className="relative shrink-0"
            onDragOver={(e) => {
              if (!dragImage || play || !onDropImage) return
              setAnySize(e.altKey)
              const r = slotAt(e, e.altKey)
              setHot(r?.id ?? '')
              if (!r) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setHot('')
            }}
            onDrop={(e) => {
              if (!dragImage || !onDropImage) return
              const r = slotAt(e, e.altKey)
              if (!r) return
              e.preventDefault()
              onDropImage(r.id, dragImage.id)
            }}
          >
            <div
              ref={stage}
              style={{ width: size.X, height: size.Y, transform: `scale(${scale})`, transformOrigin: '0 0' }}
              className="absolute top-0 left-0 overflow-hidden bg-[#0e0e10] bg-[length:24px_24px] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_12px_40px_-12px_rgba(0,0,0,0.8)] [background-image:linear-gradient(45deg,#1a1a1d_25%,transparent_25%,transparent_75%,#1a1a1d_75%),linear-gradient(45deg,#1a1a1d_25%,transparent_25%,transparent_75%,#1a1a1d_75%)] [background-position:0_0,12px_12px]"
              onPointerDown={(e) => {
                if (tool !== 'select') return
                const el = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')
                const id = el?.dataset.wid ?? ''
                if (id && (e.shiftKey || e.ctrlKey || e.metaKey) && onPick) {
                  onPick(id, true)
                  return
                }
                onSelect(id)
                // 点到的就是选中的、能拖动的控件时直接开始拖
                if (id && id === selected) {
                  if (device && parent?.Type === 'Frame') webDrag(e)
                  else drag(e, 'move')
                }
              }}
              onDoubleClick={(e) => {
                if (tool !== 'select') return
                const id = (e.target as HTMLElement).closest<HTMLElement>('[data-wid]')?.dataset.wid
                if (id) onOpen?.(id)
              }}
            >
              <UmgNode w={root} ctx={ctx} />
            </div>
            {overlay && (
              <img
                src={overlay}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
              />
            )}
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
            {!play &&
              extraBoxes.map((b, i) => (
                <div
                  key={i}
                  className="pointer-events-none absolute outline-[1.5px] outline-[#4c9bff]/70 outline-dashed"
                  style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }}
                />
              ))}
            {dragImage &&
              !play &&
              shownSlots.map((r) => (
                <div
                  key={r.id}
                  data-drop-slot={r.name}
                  className={cn(
                    'pointer-events-none absolute rounded-[2px] outline-solid',
                    r.id === hot
                      ? 'bg-[#35c46a]/25 outline-2 outline-[#35c46a]'
                      : 'bg-[#35c46a]/8 outline-[1.5px] outline-[#35c46a]/70',
                  )}
                  style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
                >
                  {r.id === hot && (
                    <span className="absolute -top-5 left-0 rounded bg-[#35c46a] px-1.5 py-px text-[0.6875rem] whitespace-nowrap text-black">
                      {t('放到 {name}', { name: r.name })}
                    </span>
                  )}
                </div>
              ))}
            {dropLine && (
              <div
                className="pointer-events-none absolute rounded-full bg-[#4c9bff]"
                style={{
                  left: dropLine.x * scale,
                  top: dropLine.y * scale,
                  width: Math.max(2, dropLine.w * scale),
                  height: Math.max(2, dropLine.h * scale),
                }}
              />
            )}
            {guides.x.map((x) => (
              <div
                key={`gx${x}`}
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#ff4fd8]"
                style={{ left: x * scale }}
              />
            ))}
            {guides.y.map((y) => (
              <div
                key={`gy${y}`}
                className="pointer-events-none absolute right-0 left-0 h-px bg-[#ff4fd8]"
                style={{ top: y * scale }}
              />
            ))}
            {!root.Children?.length && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
                <div className="max-w-[320px] text-[0.78125rem] leading-relaxed text-white/45">
                  <p className="mb-1 text-[0.84375rem] font-medium text-white/70">{t('还是空白界面')}</p>
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
      {alignable && !play && (
        <div className="pointer-events-none absolute inset-x-0 bottom-14 flex justify-center">
          <div
            role="toolbar"
            aria-label={t('对齐')}
            className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-white/10 bg-[#232326]/95 p-1 text-white/70 shadow-pop"
          >
            <span className="px-2 text-[0.71875rem] text-white/50">{t('已选 {n} 个', { n: multi.length })}</span>
            {(
              [
                ['left', AlignStartVertical, t('左对齐')],
                ['hcenter', AlignCenterVertical, t('水平居中')],
                ['right', AlignEndVertical, t('右对齐')],
                ['top', AlignStartHorizontal, t('顶对齐')],
                ['vcenter', AlignCenterHorizontal, t('垂直居中')],
                ['bottom', AlignEndHorizontal, t('底对齐')],
                ['hspace', AlignHorizontalSpaceAround, t('水平等间距')],
                ['vspace', AlignVerticalSpaceAround, t('垂直等间距')],
              ] as const
            ).map(([k, Icon, label]) => (
              <button
                key={k}
                onClick={() => align(k)}
                disabled={(k === 'hspace' || k === 'vspace') && multi.length < 3}
                aria-label={label}
                title={label}
                className="grid h-7 w-7 cursor-pointer place-items-center rounded-lg hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30"
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} />
              </button>
            ))}
          </div>
        </div>
      )}
      {play && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1 text-[0.71875rem] text-emerald-200 shadow-pop">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {t('运行模式 · 按 Esc 退出')}
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-2">
        <span className="rounded-md bg-black/50 px-2 py-1 font-mono text-[0.6875rem] text-white/60">
          {size.X} × {size.Y}
        </span>
        <div className="pointer-events-auto flex items-center rounded-lg border border-white/10 bg-[#232326]/95 text-white/80 shadow-pop">
          <ZoomButton label={t('缩小')} onClick={() => setZoom(Math.max(0.05, scale / 1.25))}>
            <Minus className="h-3.5 w-3.5" />
          </ZoomButton>
          <button
            onClick={() => setZoom(1)}
            title={t('原始大小')}
            className="h-7 w-12 cursor-pointer font-mono text-[0.71875rem] tabular-nums hover:text-white"
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
