import type { DataSet } from '../design-data.ts'
import {
  COMMON_PROPS,
  WIDGETS,
  brush,
  defaultSlot,
  uniqueName,
  type Component,
  type Widget,
  type WidgetType,
} from '../umg.ts'
import { anchorSlot, gridWidget, planGrids } from './structure.ts'
import { CONTAINER_KINDS, artScale, type Box, type RestoreElement, type RestoreState } from './schema.ts'

/**
 * 元素表 → 控件树。位置全部来自元素框（原画像素按比例换成设计稿像素），一律放在 CanvasPanel 里绝对定位、锁住；
 * 模型和用户都不直接改树上的坐标，要挪就改元素框再编译一遍。
 * 结构推断（横排、竖排、重复组抽子控件）是下一阶段的事，那时推断出来的布局也要回到这里核对位置不变。
 *
 * 父子关系按框的包含算：每个元素挂在「把它装下的最小容器」下面。容器编成 CanvasPanel，
 * 第一个子控件是铺满的底图（<名字>_Bg），后面才是它装着的元素；按钮编成 Button，里面套一层 CanvasPanel 放文字、图标
 */

export interface CompileInput {
  restore: RestoreState
  designSize: { X: number; Y: number }
  /** 元素 id → 切图（设计里的图片 id）；没有切图的容器不画底 */
  images: Record<string, string | undefined>
  /** 每张切图的九宫格边距（比例 0~1），有的按 Box 方式拉伸 */
  nineSlice?: Record<string, { Left: number; Top: number; Right: number; Bottom: number } | undefined>
  /** 结构推断：重复组抽子控件、挂在根上的控件推断锚点（不给就是最初的逐个绝对定位） */
  structure?: {
    /** 已经被占用的子控件名、数据集名 */
    taken?: Set<string>
    /** 不抽子控件的组（自动修正时整组对不上的） */
    flat?: Set<string>
    /** 不收进子控件、单独摆的元素（自动修正时和模板差太多的） */
    detached?: Set<string>
  }
}

export interface Compiled {
  root: Widget
  /** 元素 id → 控件名（校验按名字找控件的位置） */
  names: Record<string, string>
  /** 重复组抽出来的子控件和它们的数据集 */
  components: Component[]
  sets: DataSet[]
  /** 收进网格的元素：网格控件名、行列数、在网格里的框（设计稿像素，相对网格左上角） */
  grids: Record<string, { grid: string; rel: Box }>
}

/** 控件 id 跟着元素走：画布上点控件能找回是哪个元素 */
export const widgetIdOf = (elementId: string) => `r-${elementId}`
export const elementIdOf = (widgetId: string) => (widgetId.startsWith('r-') ? widgetId.slice(2) : undefined)

const area = (b: Box) => b.w * b.h
/** a 有九成以上落在 b 里 */
function within(a: Box, b: Box) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y >= area(a) * 0.9
}

/** 每个元素的父元素（undefined 是挂在根上） */
export function parentsOf(list: RestoreElement[]): Map<string, string | undefined> {
  const live = list.filter((e) => !e.hidden && e.kind !== 'background')
  const out = new Map<string, string | undefined>()
  for (const e of live) {
    let best: RestoreElement | undefined
    for (const p of live) {
      if (p === e || !CONTAINER_KINDS.includes(p.kind) || area(p.box) <= area(e.box)) continue
      if (!within(e.box, p.box)) continue
      if (!best || area(p.box) < area(best.box)) best = p
    }
    out.set(e.id, best?.id)
  }
  return out
}

function base(type: WidgetType, id: string, name: string, slot: Record<string, any> | undefined): Widget {
  const def = WIDGETS[type]
  return {
    id,
    Type: type,
    Name: name,
    ...(slot ? { Slot: slot } : {}),
    Properties: { ...COMMON_PROPS(), ...def.defaults(), Locked: true },
    ...(def.children !== 'none' ? { Children: [] } : {}),
  }
}

const canvasSlot = (b: Box) =>
  defaultSlot(
    'CanvasPanelSlot',
    Math.round(b.x),
    Math.round(b.y),
    Math.max(1, Math.round(b.w)),
    Math.max(1, Math.round(b.h)),
  )!
/** 铺满父控件：四个锚点拉开、边距 0 */
const fillSlot = () => ({
  LayoutData: {
    Offsets: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
    Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } },
    Alignment: { X: 0, Y: 0 },
  },
  bAutoSize: false,
  ZOrder: 0,
})

/** 字的像素高（笔画量出来的）→ UE 的字号：字号是 pt，1pt = 4/3 px；汉字、数字的笔画高大约是 em 的 0.85 */
export const fontSizeOf = (glyphPx: number) => Math.max(6, Math.round((glyphPx / 0.85) * 0.75))

export function compileRestore(i: CompileInput): Compiled {
  const { restore, designSize } = i
  const k = artScale(restore, designSize)
  const scaled = (b: Box): Box => ({ x: b.x * k.x, y: b.y * k.y, w: b.w * k.x, h: b.h * k.y })
  const live = restore.elements.filter((e) => !e.hidden)
  const parents = parentsOf(live)
  const names = new Set<string>(['Root'])
  const map: Record<string, string> = {}
  const nameOf = (e: RestoreElement) => {
    const n = uniqueName(e.name || `${e.kind}_${e.id}`, names)
    names.add(n)
    map[e.id] = n
    return n
  }
  const img = (id: string | undefined) => {
    const nine = id ? i.nineSlice?.[id] : undefined
    return id
      ? brush({ ResourceObject: `img:${id}`, DrawAs: nine ? 'Box' : 'Image', ...(nine ? { Margin: nine } : {}) })
      : brush({ DrawAs: 'NoDrawType' })
  }
  const bgImage = (e: RestoreElement, name: string) => {
    const w = base('Image', `${widgetIdOf(e.id)}-bg`, uniqueName(`${name}_Bg`, names), fillSlot())
    names.add(w.Name)
    w.Properties.Brush = img(i.images[e.id])
    return w
  }

  const plans = i.structure
    ? planGrids({
        elements: live,
        groups: restore.groups,
        parents,
        k,
        images: i.images,
        nineSlice: i.nineSlice,
        taken: i.structure.taken ?? new Set(),
        flat: i.structure.flat,
        detached: i.structure.detached,
        fontSize: fontSizeOf,
      })
    : []
  // 收进网格的格子和格子里的图标、数量不单独编；格子里其余的元素挂到网格的父控件下
  const skip = new Set(plans.flatMap((p) => [...p.cells.map((c) => c.e.id), ...p.absorbed.keys()]))
  const cellSet = new Set(plans.flatMap((p) => p.cells.map((c) => c.e.id)))
  const parentOf = (id: string) => {
    let p = parents.get(id)
    while (p && cellSet.has(p)) p = parents.get(p)
    return p
  }

  const root = base('CanvasPanel', 'r-root', 'Root', undefined)
  const bg = live.find((e) => e.kind === 'background')
  if (bg && i.images[bg.id]) root.Children!.push(bgImage(bg, bg.name || 'Bg_Main'))
  if (bg) map[bg.id] = root.Name

  // 先大后小：大的先放进去当容器，同一个父控件里也是大的在下层
  const order = live
    .filter((e) => e.kind !== 'background')
    .sort((a, b) => area(b.box) - area(a.box) || a.box.y - b.box.y || a.box.x - b.box.x)
  const holder = new Map<string, { widget: Widget; box: Box }>()
  for (const e of order) {
    if (skip.has(e.id)) continue
    const pid = parentOf(e.id)
    const parent = (pid && holder.get(pid)) || {
      widget: root,
      box: {
        x: 0,
        y: 0,
        w: restore.source?.width ?? designSize.X / k.x,
        h: restore.source?.height ?? designSize.Y / k.y,
      },
    }
    const local = scaled({ x: e.box.x - parent.box.x, y: e.box.y - parent.box.y, w: e.box.w, h: e.box.h })
    const name = nameOf(e)
    // 挂在根上的按离哪条边近定锚点（设计尺寸下位置不变）
    const slot = i.structure && parent.widget === root ? anchorSlot(local, designSize) : canvasSlot(local)
    let w: Widget
    if (e.kind === 'text') {
      w = base('TextBlock', widgetIdOf(e.id), name, slot)
      const t = e.text
      Object.assign(w.Properties, {
        Text: t?.content ?? '',
        ColorAndOpacity: t?.color ?? '#FFFFFFFF',
        Justification: t?.align === 'center' ? 'Center' : t?.align === 'right' ? 'Right' : 'Left',
        // 框就是原画里那一行字的位置：不换行，字号按笔画高换算
        AutoWrapText: false,
        Font: {
          ...w.Properties.Font,
          Size: fontSizeOf((t?.px ?? e.box.h) * k.y),
          TypefaceFontName: t?.bold ? 'Bold' : 'Regular',
        },
      })
    } else if (e.kind === 'button') {
      w = base('Button', widgetIdOf(e.id), name, slot)
      const b = img(i.images[e.id])
      // PSD 里画了别的状态就用画的；没有的先都用常态这一张（按下压暗、禁用半透明，状态表那一步再细派生）
      const st = (s: string) => i.images[`${e.id}:${s}`]
      w.Properties.WidgetStyle = {
        ...w.Properties.WidgetStyle,
        Normal: b,
        Hovered: st('hover') ? img(st('hover')) : { ...b },
        Pressed: st('pressed') ? img(st('pressed')) : { ...b, TintColor: '#D9D9D9FF' },
        Disabled: st('disabled') ? img(st('disabled')) : { ...b, TintColor: '#FFFFFF80' },
        NormalPadding: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
        PressedPadding: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
      }
      // 按钮只能放一个子控件：里面套一层铺满的画布，文字、图标照原画的位置摆
      const inner = base('CanvasPanel', `${widgetIdOf(e.id)}-content`, uniqueName(`${name}_Content`, names), {
        ...defaultSlot('ButtonSlot'),
        HorizontalAlignment: 'HAlign_Fill',
        VerticalAlignment: 'VAlign_Fill',
      })
      names.add(inner.Name)
      w.Children = [inner]
      holder.set(e.id, { widget: inner, box: e.box })
    } else if (CONTAINER_KINDS.includes(e.kind)) {
      w = base('CanvasPanel', widgetIdOf(e.id), name, slot)
      w.Children!.push(bgImage(e, name))
      holder.set(e.id, { widget: w, box: e.box })
    } else {
      w = base('Image', widgetIdOf(e.id), name, slot)
      w.Properties.Brush = img(i.images[e.id])
    }
    parent.widget.Children!.push(w)
  }
  const boxes = new Map(live.map((e) => [widgetIdOf(e.id), e.box]))
  const grids: Compiled['grids'] = {}
  for (const p of plans) {
    const holderOf = p.parent ? holder.get(p.parent) : undefined
    const parentBox = holderOf ? scaled(holderOf.box) : { x: 0, y: 0 }
    const local = { ...p.box, x: p.box.x - parentBox.x, y: p.box.y - parentBox.y }
    const name = uniqueName(p.name, names)
    names.add(name)
    const w = gridWidget(p, local, name)
    w.id = widgetIdOf(`grid-${p.group.id}`)
    if (!holderOf && i.structure) w.Slot = anchorSlot(local, designSize)
    ;(holderOf?.widget ?? root).Children!.push(w)
    // 网格按格子的原画框参与排序
    boxes.set(w.id, { x: p.box.x / k.x, y: p.box.y / k.y, w: p.box.w / k.x, h: p.box.h / k.y })
    for (const [id, rel] of p.rel) {
      map[id] = name
      grids[id] = { grid: name, rel }
    }
  }
  reorder(root, boxes)
  return { root, names: map, components: plans.map((p) => p.comp), sets: plans.map((p) => p.set), grids }
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * 同一个父控件里按阅读顺序排（从上到下、从左到右），大纲里格子才是 1、2、3……的顺序；
 * 叠在一起的两个，大的放前面（下层），不然小的会被盖住
 */
function reorder(w: Widget, boxes: Map<string, Box>) {
  const kids = w.Children
  if (!kids?.length) return
  const lead = kids.filter((c) => !boxes.has(c.id))
  const rest = kids
    .filter((c) => boxes.has(c.id))
    .sort((a, b) => {
      const p = boxes.get(a.id)!
      const q = boxes.get(b.id)!
      return Math.abs(p.y - q.y) > Math.min(p.h, q.h) * 0.3 ? p.y - q.y : p.x - q.x
    })
  for (let i = 0; i < rest.length; i++)
    for (let j = i + 1; j < rest.length; j++) {
      const a = boxes.get(rest[i].id)!
      const b = boxes.get(rest[j].id)!
      if (overlaps(a, b) && area(b) > area(a)) {
        const [big] = rest.splice(j, 1)
        rest.splice(i, 0, big)
      }
    }
  w.Children = [...lead, ...rest]
  for (const c of kids) reorder(c, boxes)
}
