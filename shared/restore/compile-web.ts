import { COMMON_PROPS, WIDGETS, uniqueName, type Widget, type WidgetType } from '../umg.ts'
import { CONTAINER_KINDS, artScale, type Box, type RestoreElement } from './schema.ts'
import { parentsOf, widgetIdOf, type CompileInput, type Compiled } from './compile.ts'

/**
 * 网页还原的编译：元素表 → Frame 树（flex 为主，参照 Figma 自动布局 → CSS flex）。
 * 每个容器看它的子元素能不能排成一行或一列：间距一样（差 1px 以内）、交叉轴上顶齐 / 居中 / 底齐，
 * 能就写成 Direction + Gap + Padding + AlignItems，子控件宽高写死像素；排不成的才用绝对定位（Position absolute + Pin）。
 * 搭建那一步编完按元素框核对位置，跑位的容器放进 absolute 再编一次（自动修正）。
 * 能用 CSS 画的底框（切图那一步量出的 css）写成底色、描边、圆角，不用切图
 */

export interface WebCompileInput extends CompileInput {
  /** 这些容器（元素 id；根是 'root'）不推断 flex，子控件一律绝对定位 */
  absolute?: Set<string>
}

export interface WebCompiled extends Compiled {
  /** 每个容器用了哪种排法：row / column / absolute */
  layouts: Record<string, 'row' | 'column' | 'absolute'>
}

function base(type: WidgetType, id: string, name: string): Widget {
  const def = WIDGETS[type]
  return {
    id,
    Type: type,
    Name: name,
    Properties: { ...COMMON_PROPS(), ...def.defaults(), Locked: true },
    ...(def.children !== 'none' ? { Children: [] } : {}),
  }
}

const near = (a: number, b: number, d = 1.01) => Math.abs(a - b) <= d
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0

/** 一组子元素（相对容器内框的设计稿像素）能不能排成一行 / 一列 */
export function inferFlex(kids: Box[], W: number, H: number) {
  if (!kids.length) return { dir: 'column' as const, gap: 0, pad: { l: 0, t: 0, r: 0, b: 0 }, align: 'start' }
  for (const dir of ['row', 'column'] as const) {
    const main = dir === 'row' ? 'x' : 'y'
    const len = dir === 'row' ? 'w' : 'h'
    const cross = dir === 'row' ? 'y' : 'x'
    const clen = dir === 'row' ? 'h' : 'w'
    const C = dir === 'row' ? H : W
    const list = [...kids].sort((a, b) => a[main] - b[main])
    const gaps = list.slice(1).map((b, i) => b[main] - (list[i][main] + list[i][len]))
    if (gaps.some((g) => g < -0.5)) continue
    const gap = Math.round(median(gaps))
    if (!gaps.every((g) => near(g, gap))) continue
    // 交叉轴：顶齐、居中、底齐三选一
    const starts = list.map((b) => b[cross])
    const centers = list.map((b) => b[cross] + b[clen] / 2)
    const ends = list.map((b) => b[cross] + b[clen])
    let align: string
    let p0: number
    let p1: number
    if (starts.every((v) => near(v, starts[0]))) [align, p0, p1] = ['start', starts[0], 0]
    else if (centers.every((v) => near(v, centers[0])))
      [align, p0, p1] = ['center', Math.max(0, 2 * centers[0] - C), Math.max(0, C - 2 * centers[0])]
    else if (ends.every((v) => near(v, ends[0]))) [align, p0, p1] = ['end', 0, C - ends[0]]
    else continue
    const lead = list[0][main]
    const pad = dir === 'row' ? { l: lead, t: p0, r: 0, b: p1 } : { l: p0, t: lead, r: p1, b: 0 }
    return { dir, gap, pad, align, order: list }
  }
  return undefined
}

export function compileWeb(i: WebCompileInput): WebCompiled {
  const { restore, designSize } = i
  const k = artScale(restore, designSize)
  const scaled = (b: Box): Box => ({ x: b.x * k.x, y: b.y * k.y, w: b.w * k.x, h: b.h * k.y })
  const live = restore.elements.filter((e) => !e.hidden)
  const parents = parentsOf(live)
  const names = new Set<string>(['Page'])
  const map: Record<string, string> = {}
  const layouts: WebCompiled['layouts'] = {}
  const img = (id: string | undefined) => (id ? `img:${id}` : '')
  const px = (v: number) => Math.max(1, Math.round(v))

  const root = base('Frame', 'r-root', 'Page')
  Object.assign(root.Properties, { Width: designSize.X, Height: designSize.Y })
  const bg = live.find((e) => e.kind === 'background')
  if (bg) {
    map[bg.id] = 'Page'
    if (i.images[bg.id]) root.Properties.BackgroundImage = img(i.images[bg.id])
  }

  const kidsOf = new Map<string | undefined, RestoreElement[]>()
  for (const e of live) {
    if (e.kind === 'background') continue
    const p = parents.get(e.id)
    kidsOf.set(p, [...(kidsOf.get(p) ?? []), e])
  }

  const widgetOf = (e: RestoreElement): Widget => {
    const name = uniqueName(e.name || `${e.kind}_${e.id}`, names)
    names.add(name)
    map[e.id] = name
    const b = scaled(e.box)
    let w: Widget
    if (e.kind === 'text') {
      w = base('Text', widgetIdOf(e.id), name)
      const t = e.text
      // 笔画高是字号的 0.85；行高按框高算，一行字的框就是元素框
      const size = Math.max(8, Math.round(((t?.px ?? e.box.h) * k.y) / 0.85))
      Object.assign(w.Properties, {
        Text: t?.content ?? '',
        Tag: size >= 28 ? 'h2' : 'p',
        FontSize: size,
        FontWeight: t?.bold ? 700 : 400,
        Color: t?.color ?? '#111827FF',
        TextAlign: t?.align ?? 'left',
        LineHeight: Math.round((b.h / size) * 100) / 100,
      })
    } else if (CONTAINER_KINDS.includes(e.kind)) {
      w = base('Frame', widgetIdOf(e.id), name)
      const css = e.css
      if (css)
        Object.assign(w.Properties, {
          Background: css.bg,
          Radius: Math.round(css.radius * k.x),
          BorderWidth: Math.round(css.borderWidth * k.x),
          BorderColor: css.borderColor,
        })
      else if (i.images[e.id]) w.Properties.BackgroundImage = img(i.images[e.id])
      // 状态：按钮悬停用派生的那张（或底色调亮），输入框、卡片不加
      if (e.kind === 'button') {
        const hover = i.images[`${e.id}:hover`]
        if (css) w.Properties.Hover = { Background: lighten(css.bg) }
        else if (hover) w.Properties.Hover = { BackgroundImage: img(hover) }
      }
      fillKids(w, e.id, b, Math.round((css?.borderWidth ?? 0) * k.x))
    } else {
      w = base('Picture', widgetIdOf(e.id), name)
      Object.assign(w.Properties, { Src: img(i.images[e.id]), Fit: 'fill', Alt: e.name })
    }
    Object.assign(w.Properties, { Width: px(b.w), Height: px(b.h) })
    return w
  }

  /** 摆一个容器里的子控件：先试 flex，排不成用绝对定位 */
  function fillKids(w: Widget, id: string | undefined, box: Box, border = 0) {
    const kids = kidsOf.get(id) ?? []
    // 没有子元素的容器（只有底框）不算排法，卡上的 flex 比例才不虚高
    if (!kids.length) return
    const key = id ?? 'root'
    const rel = kids.map((e) => {
      const b = scaled(e.box)
      // 子控件相对容器的内边距框（边框里面）
      return { e, b: { x: b.x - box.x - border, y: b.y - box.y - border, w: b.w, h: b.h } }
    })
    const flex = i.absolute?.has(key)
      ? undefined
      : inferFlex(
          rel.map((r) => r.b),
          box.w - border * 2,
          box.h - border * 2,
        )
    if (flex) {
      layouts[key] = flex.dir
      Object.assign(w.Properties, {
        Direction: flex.dir,
        Gap: flex.gap,
        Padding: {
          Left: Math.round(flex.pad.l),
          Top: Math.round(flex.pad.t),
          Right: Math.round(flex.pad.r),
          Bottom: Math.round(flex.pad.b),
        },
        AlignItems: flex.align,
        JustifyContent: 'start',
      })
      const order = flex.order ?? []
      for (const b of order) {
        const r = rel.find((x) => x.b === b)!
        w.Children!.push(widgetOf(r.e))
      }
      return
    }
    layouts[key] = 'absolute'
    for (const r of [...rel].sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h)) {
      const c = widgetOf(r.e)
      c.Slot = { Position: 'absolute', Pin: 'top-left', X: Math.round(r.b.x), Y: Math.round(r.b.y) }
      w.Children!.push(c)
    }
  }

  fillKids(root, undefined, { x: 0, y: 0, w: designSize.X, h: designSize.Y })
  return { root, names: map, components: [], sets: [], grids: {}, layouts }
}

function lighten(hex: string) {
  const v = [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * 1.12)))
  return `#${v.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('')}FF`
}
