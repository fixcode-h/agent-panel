import type { DataSet } from '../design-data.ts'
import { COMMON_PROPS, WIDGETS, brush, defaultSlot, type Component, type Widget, type WidgetType } from '../umg.ts'
import type { Box, ElementText, RepeatGroup, RestoreElement } from './schema.ts'

/**
 * 结构推断：重复组（背包格子、技能栏）抽成一个子控件，用 UniformGridPanel + 数据集铺开。
 * 格子大小、间距、行列数都来自拆解那一步量出的组（findGroups），不靠模型数。
 * 每个格子里最大的那张图当「图标」、第一段字当「数量」，换成子控件里绑了数据字段的控件；
 * 底图和多数格子不一样的格子（原画里画的选中态）记成数据里的 selected，子控件里多一张高亮图按状态显示。
 * 模板的位置取各格子的中位数：和模板差太多的元素由搭建那一步的自动修正挪出来单独摆（detached），
 * 整组都对不上的组（flat）不抽子控件，回到逐个绝对定位
 */

export interface GridPlan {
  group: RepeatGroup
  /** 格子元素和它在第几行第几列 */
  cells: { e: RestoreElement; col: number; row: number }[]
  /** 格子里被收进子控件的元素：图标、数量 */
  absorbed: Map<string, 'icon' | 'count'>
  /** 格子的父元素（网格挂在它下面） */
  parent: string | undefined
  comp: Component
  set: DataSet
  /** 网格控件的位置（设计稿像素，绝对坐标） */
  box: Box
  /** 每个元素在网格里的位置：格子的行列和相对格子左上角（含间距的一半）的框，校验按它算 */
  rel: Map<string, Box>
  name: string
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}

function widget(type: WidgetType, name: string, slot?: Record<string, any>): Widget {
  const def = WIDGETS[type]
  return {
    id: `rs-${name}-${Math.random().toString(36).slice(2, 8)}`,
    Type: type,
    Name: name,
    ...(slot ? { Slot: slot } : {}),
    Properties: { ...COMMON_PROPS(), ...def.defaults() },
    ...(def.children !== 'none' ? { Children: [] } : {}),
  }
}

const fill = () => ({
  LayoutData: {
    Offsets: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
    Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } },
    Alignment: { X: 0, Y: 0 },
  },
  bAutoSize: false,
  ZOrder: 0,
})
const at = (b: Box) =>
  defaultSlot(
    'CanvasPanelSlot',
    Math.round(b.x),
    Math.round(b.y),
    Math.max(1, Math.round(b.w)),
    Math.max(1, Math.round(b.h)),
  )!

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')

export function planGrids(o: {
  elements: RestoreElement[]
  groups: RepeatGroup[]
  parents: Map<string, string | undefined>
  /** 原画像素 → 设计稿像素 */
  k: { x: number; y: number }
  images: Record<string, string | undefined>
  nineSlice?: Record<string, { Left: number; Top: number; Right: number; Bottom: number } | undefined>
  /** 已经用掉的子控件名、数据集名 */
  taken: Set<string>
  flat?: Set<string>
  detached?: Set<string>
  /** 文字的字号换算（和 compile 一致） */
  fontSize: (px: number) => number
}): GridPlan[] {
  const { k } = o
  const out: GridPlan[] = []
  const kidsOf = new Map<string, RestoreElement[]>()
  for (const e of o.elements) {
    const p = o.parents.get(e.id)
    if (p) kidsOf.set(p, [...(kidsOf.get(p) ?? []), e])
  }
  for (const g of o.groups) {
    if (o.flat?.has(g.id) || g.rows * g.cols < 3) continue
    const members = o.elements.filter((e) => e.repeat === g.id && !e.hidden)
    if (members.length < 3) continue
    // 同一个父元素下的才能并成一个网格
    const parent = o.parents.get(members[0].id)
    if (members.some((e) => o.parents.get(e.id) !== parent)) continue
    const px = g.cell.w + g.gap.x
    const py = g.cell.h + g.gap.y
    const cells = members.map((e) => ({
      e,
      col: Math.max(0, Math.min(g.cols - 1, Math.round((e.box.x - g.origin.x) / px))),
      row: Math.max(0, Math.min(g.rows - 1, Math.round((e.box.y - g.origin.y) / py))),
    }))
    // 两个元素落到同一格（组量得不准）：不抽
    if (new Set(cells.map((c) => c.row * g.cols + c.col)).size !== cells.length) continue

    // 设计稿像素：格子、间距、网格
    const cw = Math.round(g.cell.w * k.x)
    const ch = Math.round(g.cell.h * k.y)
    const gx = Math.max(0, Math.round(g.gap.x * k.x))
    const gy = Math.max(0, Math.round(g.gap.y * k.y))
    const box = {
      x: g.origin.x * k.x - gx / 2,
      y: g.origin.y * k.y - gy / 2,
      w: g.cols * (cw + gx),
      h: g.rows * (ch + gy),
    }
    // 每格里的图标（最大的非文字元素）、数量（第一段字）
    const partsOf = (c: RestoreElement) => {
      const kids = (kidsOf.get(c.id) ?? []).filter((x) => !x.hidden && !o.detached?.has(x.id))
      const icon = kids.filter((x) => x.kind !== 'text').sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0]
      const count = kids.filter((x) => x.kind === 'text').sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)[0]
      return { icon, count }
    }
    const relOf = (c: RestoreElement, x: RestoreElement): Box => ({
      x: (x.box.x - c.box.x) * k.x,
      y: (x.box.y - c.box.y) * k.y,
      w: x.box.w * k.x,
      h: x.box.h * k.y,
    })
    const parts = cells.map((c) => ({ ...c, ...partsOf(c.e) }))
    const tpl = (pick: 'icon' | 'count'): Box | undefined => {
      const list = parts.flatMap((p) => (p[pick] ? [relOf(p.e, p[pick]!)] : []))
      if (!list.length) return undefined
      return {
        x: median(list.map((b) => b.x)),
        y: median(list.map((b) => b.y)),
        w: median(list.map((b) => b.w)),
        h: median(list.map((b) => b.h)),
      }
    }
    const iconBox = tpl('icon')
    const countBox = tpl('count')
    const countText: ElementText | undefined = parts.find((p) => p.count)?.count?.text

    // 底图：多数格子用的那张；不一样的格子是原画里画的选中态
    const tally = new Map<string, number>()
    for (const c of cells) {
      const id = o.images[c.e.id]
      if (id) tally.set(id, (tally.get(id) ?? 0) + 1)
    }
    const common = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const odds = cells.filter((c) => o.images[c.e.id] && o.images[c.e.id] !== common)
    // 只有一格不一样：那是原画里画的选中态，记成状态；好几格各不一样：每格的底图放进数据里
    const highlight = odds.length === 1 ? o.images[odds[0].e.id] : undefined
    const perCellBg = odds.length > 1

    const base0 = pascal(g.name) || pascal((members[0].name || '').replace(/_?\d+$/, '')) || 'Item'
    let name = `WBP_${base0}`
    for (let i = 2; o.taken.has(name); i++) name = `WBP_${base0}${i}`
    o.taken.add(name)
    let setName = `${base0}Items`
    for (let i = 2; o.taken.has(setName); i++) setName = `${base0}Items${i}`
    o.taken.add(setName)

    const img = (id: string | undefined) => {
      const nine = id ? o.nineSlice?.[id] : undefined
      return id
        ? brush({ ResourceObject: `img:${id}`, DrawAs: nine ? 'Box' : 'Image', ...(nine ? { Margin: nine } : {}) })
        : brush({ DrawAs: 'NoDrawType' })
    }
    const root = widget('CanvasPanel', 'Root')
    const bg = widget('Image', 'Bg', fill())
    bg.Properties.Brush = img(common)
    if (perCellBg) bg.Properties.DataField = 'bg'
    root.Children!.push(bg)
    if (highlight) {
      const h = widget('Image', 'Highlight', fill())
      h.Properties.Brush = img(highlight)
      h.Properties.RenderOpacity = 0
      h.Properties.States = [
        { Name: 'Selected', When: { Field: 'selected', Equals: true }, Properties: { RenderOpacity: 1 } },
      ]
      root.Children!.push(h)
    }
    if (iconBox) {
      const w = widget('Image', 'Icon', at(iconBox))
      const first = parts.find((p) => p.icon)?.icon
      w.Properties.Brush = img(first && o.images[first.id])
      w.Properties.DataField = 'icon'
      root.Children!.push(w)
    }
    if (countBox) {
      const w = widget('TextBlock', 'Count', at(countBox))
      Object.assign(w.Properties, {
        Text: countText?.content ?? '',
        ColorAndOpacity: countText?.color ?? '#FFFFFFFF',
        Justification: countText?.align === 'center' ? 'Center' : countText?.align === 'left' ? 'Left' : 'Right',
        AutoWrapText: false,
        DataField: 'count',
        Font: {
          ...w.Properties.Font,
          Size: o.fontSize((countText?.px ?? countBox.h / k.y) * k.y),
          TypefaceFontName: countText?.bold ? 'Bold' : 'Regular',
        },
      })
      root.Children!.push(w)
    }
    const comp: Component = { Name: name, DesignSize: { X: cw, Y: ch }, Root: root }

    // 数据：每格一行（行优先）；原画里没有的格子是空行
    const byIndex = new Map(parts.map((p) => [p.row * g.cols + p.col, p]))
    const rows = Array.from({ length: g.rows * g.cols }, (_, i) => {
      const p = byIndex.get(i)
      const own = p && o.images[p.e.id]
      return {
        ...(perCellBg ? { bg: `img:${own || common}` } : {}),
        icon: p?.icon && o.images[p.icon.id] ? `img:${o.images[p.icon.id]}` : '',
        count: p?.count?.text?.content ?? '',
        ...(highlight ? { selected: !!p && o.images[p.e.id] === highlight } : {}),
      }
    })
    const set: DataSet = {
      id: `rs_${g.id}`,
      name: setName,
      label: '',
      fields: [
        ...(perCellBg ? [{ key: 'bg', label: '底图', type: 'image' as const, widget: `${name} / Bg`, note: '' }] : []),
        { key: 'icon', label: '图标', type: 'image', widget: `${name} / Icon`, note: '' },
        { key: 'count', label: '数量', type: 'string', widget: `${name} / Count`, note: '' },
        ...(highlight
          ? [{ key: 'selected', label: '选中', type: 'boolean' as const, widget: `${name} / Highlight`, note: '' }]
          : []),
      ],
      rows,
    }

    const absorbed = new Map<string, 'icon' | 'count'>()
    const rel = new Map<string, Box>()
    for (const p of parts) {
      const cell = { x: p.col * (cw + gx) + gx / 2, y: p.row * (ch + gy) + gy / 2 }
      rel.set(p.e.id, { ...cell, w: cw, h: ch })
      if (p.icon && iconBox) {
        absorbed.set(p.icon.id, 'icon')
        rel.set(p.icon.id, { x: cell.x + iconBox.x, y: cell.y + iconBox.y, w: iconBox.w, h: iconBox.h })
      }
      if (p.count && countBox) {
        absorbed.set(p.count.id, 'count')
        rel.set(p.count.id, { x: cell.x + countBox.x, y: cell.y + countBox.y, w: countBox.w, h: countBox.h })
      }
    }
    out.push({ group: g, cells, absorbed, parent, comp, set, box, rel, name: `Grid_${base0}` })
  }
  return out
}

/** 网格控件：格子数、列数、间距（每格四周各一半）、绑定的数据集 */
export function gridWidget(p: GridPlan, local: Box, name: string): Widget {
  const w = widget('UniformGridPanel', name, at(local))
  const g = p.group
  const gx = (local.w / g.cols - p.comp.DesignSize.X) / 2
  const gy = (local.h / g.rows - p.comp.DesignSize.Y) / 2
  Object.assign(w.Properties, {
    EntryWidgetClass: p.comp.Name,
    NumEntries: g.rows * g.cols,
    NumColumns: g.cols,
    SlotPadding: { Left: gx, Top: gy, Right: gx, Bottom: gy },
    DataSet: p.set.name,
    Locked: true,
  })
  return w
}

/**
 * 锚点：挂在根上的控件按离哪条边近锚哪边（顶栏锚顶、右上角的货币锚右上、底部按钮锚底、居中的弹窗锚中心），
 * 换分辨率时离那条边的距离不变。只改锚点和偏移，设计尺寸下的位置一个像素都不变
 */
export function anchorSlot(b: Box, size: { X: number; Y: number }) {
  const axis = (pos: number, len: number, total: number) => {
    const c = pos + len / 2
    if (len >= total * 0.9) return 0
    if (Math.abs(c - total / 2) <= total * 0.05) return 0.5
    if (c < total / 3) return 0
    if (c > (total * 2) / 3) return 1
    return 0.5
  }
  const ax = axis(b.x, b.w, size.X)
  const ay = axis(b.y, b.h, size.Y)
  return {
    LayoutData: {
      Offsets: {
        Left: Math.round(b.x - ax * size.X),
        Top: Math.round(b.y - ay * size.Y),
        Right: Math.max(1, Math.round(b.w)),
        Bottom: Math.max(1, Math.round(b.h)),
      },
      Anchors: { Minimum: { X: ax, Y: ay }, Maximum: { X: ax, Y: ay } },
      Alignment: { X: 0, Y: 0 },
    },
    bAutoSize: false,
    ZOrder: 0,
  }
}
