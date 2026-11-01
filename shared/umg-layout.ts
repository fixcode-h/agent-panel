import { WIDGETS, entryCount, fontPx, isWebType, type Component, type SlotType, type Widget } from './umg.ts'
import { dataRows, type DesignData } from './design-data.ts'

/**
 * 不靠页面、直接算出 UMG 控件树里每个控件在画布上的位置（设计稿像素）。
 *
 * 为什么要有它：AI 改完控件要「回读」位置和尺寸，以前只能调 screenshot，
 * 而截图要页面开着（画布是浏览器画的）。这里照 web/src/components/design/umg-render.tsx
 * 的排版规则（CanvasPanel 锚点 + 偏移 + 对齐、横竖排的 Auto / Fill、Overlay、SizeBox……）
 * 一条条算，结果和截图返回的控件位置表同一个口径（控件本体的外框，含 RenderTransform）。
 *
 * 算不准的地方标 est：文字的宽高靠字宽表估（浏览器里的真实字形量不到），
 * 位置被这些估出来的尺寸推着走的控件也跟着标。改 umg-render 的排版时要同步改这里，
 * 对照测试在 shared/umg-layout.test.ts。网页设计（Frame 等）不在这里算，返回 undefined。
 */

export interface LayoutRect {
  name: string
  type: string
  x: number
  y: number
  w: number
  h: number
  /** 尺寸或位置依赖文字宽度的估算，和画布可能差几个像素 */
  est?: boolean
}

interface Size {
  w: number
  h: number
  est?: boolean
}
interface Box extends Size {
  x: number
  y: number
}

interface Ctx {
  comps: Map<string, Component>
  data?: DesignData
  out: LayoutRect[]
}

// ---------- 文字 ----------

/** 估一个字的宽度（em）：Roboto 的平均字宽；中日韩字和全角符号按 1em */
function charEm(c: string) {
  const code = c.codePointAt(0) ?? 0
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3000 && code <= 0x303f)
  )
    return 1
  if (c === ' ') return 0.25
  if (/[0-9]/.test(c)) return 0.56
  if (/[A-Z]/.test(c)) return 0.64
  if (/[a-z]/.test(c)) return /[ilj]/.test(c) ? 0.24 : /[mw]/.test(c) ? 0.85 : 0.52
  if (/[.,:;'!|]/.test(c)) return 0.25
  return 0.5
}

const LINE_HEIGHT = 1.2

/** 文字的宽高：wrap 时按 width 折行（中文任意处断开，英文在空格处断，太长的词硬断） */
export function measureText(
  text: string,
  o: { px: number; letterSpacingEm?: number; wrap?: boolean; width?: number },
): { w: number; h: number; lines: number } {
  const ls = (o.letterSpacingEm ?? 0) * o.px
  const cw = (c: string) => charEm(c) * o.px + ls
  const lines: number[] = []
  for (const raw of text.split('\n')) {
    if (!o.wrap || !(o.width! > 0)) {
      lines.push([...raw].reduce((n, c) => n + cw(c), 0))
      continue
    }
    // 按「词」切：连续的拉丁字母数字算一个词，其余每个字单独一段
    const tokens = raw.match(/[A-Za-z0-9_\-'.,!?]+|\s|./gu) ?? []
    let cur = 0
    for (const tk of tokens) {
      const w = [...tk].reduce((n, c) => n + cw(c), 0)
      if (cur > 0 && cur + w > o.width! + 0.01 && !/^\s$/.test(tk)) {
        lines.push(cur)
        cur = 0
      }
      if (w > o.width! && tk.length > 1) {
        // 一个词比整行还长：overflow-wrap: anywhere，逐字断开
        for (const c of tk) {
          const x = cw(c)
          if (cur > 0 && cur + x > o.width! + 0.01) {
            lines.push(cur)
            cur = 0
          }
          cur += x
        }
      } else if (!(cur === 0 && /^\s$/.test(tk) && lines.length)) cur += w
    }
    lines.push(cur)
  }
  return { w: Math.max(0, ...lines), h: lines.length * o.px * LINE_HEIGHT, lines: lines.length }
}

// ---------- 控件本体的尺寸规则（和 umg-render 的 UmgBody 一致） ----------

interface Spec {
  /** CSS 里写死的宽 / 高 */
  fw?: number
  fh?: number
  /** 在横向（插槽外壳是横排 flex）上撑满 */
  growX: boolean
  /** 纵向拉伸（没写死高度时才生效） */
  stretchY: boolean
  minW?: number
  maxW?: number
  minH?: number
  maxH?: number
  /** 控件自己的内边距（Button 的 NormalPadding、EditableTextBox） */
  pad?: Pad
}

interface Pad {
  l: number
  t: number
  r: number
  b: number
}
const ZERO: Pad = { l: 0, t: 0, r: 0, b: 0 }
const padOf = (m: any): Pad =>
  m && typeof m === 'object'
    ? { l: Number(m.Left) || 0, t: Number(m.Top) || 0, r: Number(m.Right) || 0, b: Number(m.Bottom) || 0 }
    : ZERO
const num = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined)

const visible = (w: Widget) => w.Properties?.Visibility !== 'Collapsed'
const kids = (w: Widget) => (w.Children ?? []).filter(visible)

function specOf(w: Widget, fillX: boolean, fillY: boolean, ctx: Ctx): Spec {
  const p = w.Properties ?? {}
  const s: Spec = { growX: fillX, stretchY: fillY }
  const fixed = (x: number, y: number) => {
    if (!fillX) s.fw = x
    if (!fillY) s.fh = y
  }
  switch (w.Type) {
    case 'CanvasPanel':
      fixed(0, 0)
      break
    case 'SizeBox':
      if (num(p.WidthOverride)) {
        s.fw = num(p.WidthOverride)
        s.growX = false
      }
      if (num(p.HeightOverride)) {
        s.fh = num(p.HeightOverride)
        s.stretchY = false
      }
      s.minW = num(p.MinDesiredWidth)
      s.minH = num(p.MinDesiredHeight)
      s.maxW = num(p.MaxDesiredWidth)
      s.maxH = num(p.MaxDesiredHeight)
      break
    case 'Spacer':
      s.fw = Number(p.Size?.X) || 0
      s.fh = Number(p.Size?.Y) || 0
      break
    case 'Image':
      fixed(p.Brush?.ImageSize?.X ?? 32, p.Brush?.ImageSize?.Y ?? 32)
      break
    case 'ProgressBar':
      fixed(p.WidgetStyle?.BackgroundImage?.ImageSize?.X ?? 200, p.WidgetStyle?.BackgroundImage?.ImageSize?.Y ?? 16)
      break
    case 'Slider': {
      const th = p.WidgetStyle?.NormalThumbImage?.ImageSize
      if (p.Orientation === 'Orient_Vertical') fixed(th?.X ?? 16, 160)
      else fixed(160, th?.Y ?? 16)
      break
    }
    case 'Button':
      s.pad = padOf(p.WidgetStyle?.NormalPadding)
      break
    case 'EditableTextBox':
      s.pad = { l: 8, t: 4, r: 8, b: 4 }
      if (!fillX) s.minW = 160
      break
    case 'UserWidget': {
      const comp = ctx.comps.get(w.Class ?? '')
      if (comp) fixed(comp.DesignSize.X, comp.DesignSize.Y)
      else fixed(96, 48)
      break
    }
    case 'UniformGridPanel':
    case 'ListView':
    case 'TileView':
    case 'DynamicEntryBox':
      if (placeholder(w, ctx)) fixed(200, 120)
      break
  }
  return s
}

/** 列表 / 网格画不出条目时显示的虚线占位块（不撑满时 200×120），和 umg-render 的判断一致 */
function placeholder(w: Widget, ctx: Ctx) {
  if (w.Type === 'UniformGridPanel' && (w.Children?.length ?? 0) > 0) return false
  const p = w.Properties ?? {}
  const comp = ctx.comps.get(String(p.EntryWidgetClass ?? ''))
  const rows = dataRows(ctx.data, w)
  if (w.Type === 'UniformGridPanel') return !comp || !(rows ? rows.length : entryCount(w))
  const n = rows ? rows.length : Math.max(0, Math.min(50, Number(p.NumDesignerPreviewEntries) || 0))
  return !comp || (!rows && !n)
}

/** 占位块里的一行小字（11px）：撑满、按内容排版时它就是占位块的大小 */
function placeholderText(w: Widget, ctx: Ctx): Size {
  const p = w.Properties ?? {}
  const rows = dataRows(ctx.data, w)
  const label = `${w.Type}${p.EntryWidgetClass ? ` · ${p.EntryWidgetClass}` : ''}${rows ? ` · ${rows.length} 行数据` : ''}`
  // 网格绑了空集合时是一块空白，没有字
  if (w.Type === 'UniformGridPanel' && rows && !rows.length && ctx.comps.has(String(p.EntryWidgetClass ?? '')))
    return { w: 0, h: 0 }
  const m = measureText(label, { px: 11 })
  return { w: m.w, h: m.h, est: true }
}

const clampW = (s: Spec, v: number) => Math.min(s.maxW ?? Infinity, Math.max(s.minW ?? 0, v))
const clampH = (s: Spec, v: number) => Math.min(s.maxH ?? Infinity, Math.max(s.minH ?? 0, v))

// ---------- 内容尺寸（max-content） ----------

/** 插槽外壳的内边距：横竖排、Overlay 等写在插槽上，UniformGrid 用网格的 SlotPadding */
function slotPad(slotType: SlotType | undefined, slot: any, parent?: Widget): Pad {
  if (!slotType || slotType === 'CanvasPanelSlot') return ZERO
  if (slotType === 'UniformGridSlot') return padOf(parent?.Properties?.SlotPadding)
  return padOf(slot?.Padding)
}

/** 子控件放进父控件时外壳的内容尺寸（外壳内边距 + 本体） */
function outerContent(c: Widget, parent: Widget, ctx: Ctx, width?: number): Size {
  const st = WIDGETS[parent.Type]?.slot
  const p = slotPad(st, c.Slot, parent)
  const { fillX, fillY } = fills(st, c.Slot)
  const spec = specOf(c, fillX, fillY, ctx)
  // 不横向撑满的本体（左 / 中 / 右对齐）宽度就是内容宽，文字不按外壳宽度折行（umg-render 里是 0 0 auto）
  const inner = width === undefined || !spec.growX ? undefined : Math.max(0, width - p.l - p.r)
  const b = bodyContent(c, spec, ctx, inner)
  return { w: b.w + p.l + p.r, h: b.h + p.t + p.b, est: b.est }
}

/** 插槽决定本体要不要横向撑满、纵向拉伸（umg-render 的 slotStyle） */
function fills(slotType: SlotType | undefined, slot: any) {
  if (!slotType || !slot || slotType === 'CanvasPanelSlot') return { fillX: true, fillY: true }
  return {
    fillX: (slot.HorizontalAlignment ?? 'HAlign_Fill') === 'HAlign_Fill',
    fillY: (slot.VerticalAlignment ?? 'VAlign_Fill') === 'VAlign_Fill',
  }
}

/**
 * 本体按内容的尺寸；width 是已经定下的宽度（文字按它折行）。
 * 写死的宽高直接用，SizeBox 的上下限也夹进去
 */
function bodyContent(w: Widget, s: Spec, ctx: Ctx, width?: number): Size {
  const pad = s.pad ?? ZERO
  const cw = s.fw ?? (width !== undefined ? width : undefined)
  const inner = cw === undefined ? undefined : Math.max(0, cw - pad.l - pad.r)
  const c = contentOf(w, ctx, inner)
  const W = s.fw ?? c.w + pad.l + pad.r
  const H = s.fh ?? c.h + pad.t + pad.b
  return { w: clampW(s, W), h: clampH(s, H), est: c.est }
}

/** 有自身尺寸的控件的期望尺寸：撑满时画布里的占位块（umg-render 的 Sizer）给出的内容尺寸 */
function ownSize(w: Widget, ctx: Ctx): Size | undefined {
  const p = w.Properties ?? {}
  switch (w.Type) {
    case 'Image':
      return { w: p.Brush?.ImageSize?.X ?? 32, h: p.Brush?.ImageSize?.Y ?? 32 }
    case 'ProgressBar':
      return {
        w: p.WidgetStyle?.BackgroundImage?.ImageSize?.X ?? 200,
        h: p.WidgetStyle?.BackgroundImage?.ImageSize?.Y ?? 16,
      }
    case 'Slider': {
      const th = p.WidgetStyle?.NormalThumbImage?.ImageSize
      return p.Orientation === 'Orient_Vertical' ? { w: th?.X ?? 16, h: 160 } : { w: 160, h: th?.Y ?? 16 }
    }
    case 'UserWidget': {
      const comp = ctx.comps.get(w.Class ?? '')
      return comp ? { w: comp.DesignSize.X, h: comp.DesignSize.Y } : undefined
    }
  }
  return undefined
}

function contentOf(w: Widget, ctx: Ctx, width?: number): Size {
  const p = w.Properties ?? {}
  const list = kids(w)
  const own = ownSize(w, ctx)
  if (own) return own
  switch (w.Type) {
    case 'TextBlock': {
      const f = p.Font ?? {}
      const m = measureText(String(p.Text ?? ''), {
        px: fontPx(f.Size ?? 24),
        letterSpacingEm: f.LetterSpacing ? f.LetterSpacing / 1000 : 0,
        wrap: !!p.AutoWrapText,
        width,
      })
      return { w: m.w, h: m.h, est: true }
    }
    case 'EditableTextBox': {
      const px = fontPx(p.Font?.Size ?? 18)
      const m = measureText(String(p.Text || p.HintText || ''), { px })
      return { w: m.w, h: m.h, est: true }
    }
    case 'HorizontalBox':
    case 'VerticalBox': {
      const row = w.Type === 'HorizontalBox'
      let a = 0
      let b = 0
      let est = false
      for (const c of list) {
        const o = outerContent(c, w, ctx, row ? undefined : width)
        a += row ? o.w : o.h
        b = Math.max(b, row ? o.h : o.w)
        est ||= !!o.est
      }
      return row ? { w: a, h: b, est } : { w: b, h: a, est }
    }
    case 'ScrollBox':
    case 'WrapBox': {
      const row = w.Type === 'WrapBox' ? p.Orientation !== 'Orient_Vertical' : p.Orientation === 'Orient_Horizontal'
      const gx = w.Type === 'WrapBox' ? Number(p.InnerSlotPadding?.X) || 0 : 0
      const gy = w.Type === 'WrapBox' ? Number(p.InnerSlotPadding?.Y) || 0 : 0
      let a = 0
      let b = 0
      let est = false
      list.forEach((c, i) => {
        const o = outerContent(c, w, ctx, row ? undefined : width)
        a += (row ? o.w : o.h) + (i ? (row ? gx : gy) : 0)
        b = Math.max(b, row ? o.h : o.w)
        est ||= !!o.est
      })
      return row ? { w: a, h: b, est } : { w: b, h: a, est }
    }
    case 'CheckBox': {
      const b = p.WidgetStyle?.[p.CheckedState === 'Checked' ? 'CheckedImage' : 'UncheckedImage']
      const bw = b?.ImageSize?.X ?? 24
      const bh = b?.ImageSize?.Y ?? 24
      let x = bw
      let h = bh
      let est = false
      for (const c of list) {
        const o = outerContent(c, w, ctx)
        x += 6 + o.w
        h = Math.max(h, o.h)
        est ||= !!o.est
      }
      return { w: x, h, est }
    }
    case 'UniformGridPanel': {
      if (list.length) {
        const cols = Math.max(1, ...list.map((k) => (k.Slot?.Column ?? 0) + 1))
        const rows = Math.max(1, ...list.map((k) => (k.Slot?.Row ?? 0) + 1))
        let cw = Number(p.MinDesiredSlotWidth) || 0
        let ch = Number(p.MinDesiredSlotHeight) || 0
        let est = false
        for (const c of list) {
          const o = outerContent(c, w, ctx)
          cw = Math.max(cw, o.w)
          ch = Math.max(ch, o.h)
          est ||= !!o.est
        }
        return { w: cw * cols, h: ch * rows, est }
      }
      if (placeholder(w, ctx)) return placeholderText(w, ctx)
      const g = gridCells(w, ctx)
      return g ? { w: g.cellW * g.cols, h: g.cellH * g.rows } : { w: 0, h: 0 }
    }
    case 'ListView':
    case 'TileView':
    case 'DynamicEntryBox': {
      if (placeholder(w, ctx)) return placeholderText(w, ctx)
      const e = entries(w, ctx)
      if (!e) return { w: 0, h: 0 }
      if (e.overlay) return { w: e.iw, h: e.ih }
      const main = e.n * (e.vertical ? e.ih : e.iw) + Math.max(0, e.n - 1) * (e.vertical ? e.gy : e.gx)
      const cross = e.vertical ? e.iw : e.ih
      // 换行的列表（TileView、Wrap）按一行 / 一列排开估，实际会按宽度折
      return e.vertical ? { w: cross, h: main, est: e.wrap } : { w: main, h: cross, est: e.wrap }
    }
    default: {
      // Overlay、Border、Button、SizeBox、ScaleBox、WidgetSwitcher 以及只有一个子控件的容器：取最大的那个
      const shown = w.Type === 'WidgetSwitcher' ? switcherChild(w) : list
      let mw = 0
      let mh = 0
      let est = false
      for (const c of shown) {
        const o = outerContent(c, w, ctx, width)
        mw = Math.max(mw, o.w)
        mh = Math.max(mh, o.h)
        est ||= !!o.est
      }
      return { w: mw, h: mh, est }
    }
  }
}

function switcherChild(w: Widget): Widget[] {
  const all = w.Children ?? []
  const i = Math.min(Number(w.Properties?.ActiveWidgetIndex) || 0, all.length - 1)
  const c = all[Math.max(0, i)]
  return c && visible(c) ? [c] : []
}

function gridCells(w: Widget, ctx: Ctx) {
  const p = w.Properties ?? {}
  const comp = ctx.comps.get(String(p.EntryWidgetClass ?? ''))
  const rows = dataRows(ctx.data, w)
  const n = rows ? rows.length : entryCount(w)
  if (!comp || !n) return undefined
  const cols = Math.min(n, Math.max(1, Number(p.NumColumns) || 1))
  const sp = padOf(p.SlotPadding)
  return {
    cols,
    rows: Math.ceil(n / cols),
    cellW: Math.max(Number(p.MinDesiredSlotWidth) || 0, comp.DesignSize.X + sp.l + sp.r),
    cellH: Math.max(Number(p.MinDesiredSlotHeight) || 0, comp.DesignSize.Y + sp.t + sp.b),
  }
}

function entries(w: Widget, ctx: Ctx) {
  const p = w.Properties ?? {}
  const comp = ctx.comps.get(String(p.EntryWidgetClass ?? ''))
  const rows = dataRows(ctx.data, w)
  const n = rows ? rows.length : Math.max(0, Math.min(50, Number(p.NumDesignerPreviewEntries) || 0))
  if (!comp || !n) return undefined
  const tile = w.Type === 'TileView'
  const vertical =
    w.Type === 'DynamicEntryBox' ? /Vertical/.test(p.EntryBoxType) : p.Orientation !== 'Orient_Horizontal'
  return {
    n,
    vertical: tile ? !vertical : vertical,
    wrap: tile || /Wrap/.test(p.EntryBoxType ?? ''),
    overlay: p.EntryBoxType === 'Overlay',
    iw: tile ? Number(p.EntryWidth) || 0 : comp.DesignSize.X,
    ih: tile ? Number(p.EntryHeight) || 0 : comp.DesignSize.Y,
    gx: w.Type === 'ListView' ? Number(p.EntrySpacing) || 0 : Number(p.EntrySpacing?.X) || 0,
    gy: w.Type === 'ListView' ? Number(p.EntrySpacing) || 0 : Number(p.EntrySpacing?.Y) || 0,
  }
}

// ---------- 摆放 ----------

const H_POS: Record<string, number> = { HAlign_Left: 0, HAlign_Center: 0.5, HAlign_Right: 1, HAlign_Fill: 0 }
const V_POS: Record<string, number> = { VAlign_Top: 0, VAlign_Center: 0.5, VAlign_Bottom: 1, VAlign_Fill: 0 }

/**
 * 一个子控件放进父控件分到的区域（插槽外壳）：外壳是横排 flex，按插槽的对齐摆本体。
 * est 表示这块区域本身就是估出来的
 */
function placeIn(
  w: Widget,
  slotType: SlotType | undefined,
  parent: Widget | undefined,
  area: Box,
  ctx: Ctx,
  depth: number,
) {
  const { fillX, fillY } = fills(slotType, w.Slot)
  const pad = slotPad(slotType, w.Slot, parent)
  const cx = area.x + pad.l
  const cy = area.y + pad.t
  const cw = Math.max(0, area.w - pad.l - pad.r)
  const ch = Math.max(0, area.h - pad.t - pad.b)
  const s = specOf(w, fillX, fillY, ctx)
  const wd = s.growX ? clampW(s, cw) : bodyContent(w, s, ctx).w
  const content = bodyContent(w, s, ctx, wd)
  const ht = s.stretchY && s.fh === undefined ? clampH(s, ch) : content.h
  const canvas = slotType === 'CanvasPanelSlot' || !slotType
  const hk = canvas ? 0 : (H_POS[w.Slot?.HorizontalAlignment ?? 'HAlign_Fill'] ?? 0)
  const vk = canvas ? 0 : (V_POS[w.Slot?.VerticalAlignment ?? 'VAlign_Fill'] ?? 0)
  const est = !!area.est || (!!content.est && (!s.growX || !(s.stretchY && s.fh === undefined) || hk > 0 || vk > 0))
  const box: Box = { x: cx + (cw - wd) * hk, y: cy + (ch - ht) * vk, w: wd, h: ht, est }
  arrange(w, box, ctx, depth)
}

/** 本体定下来以后：记下位置，再摆里面的子控件 */
function arrange(w: Widget, box: Box, ctx: Ctx, depth: number) {
  ctx.out.push({
    name: w.Name,
    type: w.Type,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    ...(box.est ? { est: true } : {}),
  })
  if (depth > 40) return
  const p = w.Properties ?? {}
  const st = WIDGETS[w.Type]?.slot
  const list = kids(w)
  const pad = w.Type === 'Button' ? padOf(p.WidgetStyle?.NormalPadding) : ZERO
  const inner: Box = {
    x: box.x + pad.l,
    y: box.y + pad.t,
    w: Math.max(0, box.w - pad.l - pad.r),
    h: Math.max(0, box.h - pad.t - pad.b),
    est: box.est,
  }
  switch (w.Type) {
    case 'CanvasPanel':
      for (const c of list) placeIn(c, st, w, canvasArea(c, w, inner, ctx), ctx, depth + 1)
      return
    case 'HorizontalBox':
    case 'VerticalBox':
      return boxLayout(w, list, inner, w.Type === 'HorizontalBox', ctx, depth)
    case 'ScrollBox':
    case 'WrapBox':
      return flowLayout(w, list, inner, ctx, depth)
    case 'CheckBox': {
      const b = p.WidgetStyle?.[p.CheckedState === 'Checked' ? 'CheckedImage' : 'UncheckedImage']
      let x = inner.x + (b?.ImageSize?.X ?? 24) + 6
      for (const c of list) {
        // 复选框里的文字：横排、上下居中，占满剩下的宽度（CheckBoxSlot 的外壳是 1 1 auto）
        const o = outerContent(c, w, ctx)
        const ow = Math.max(0, inner.x + inner.w - x)
        placeIn(
          c,
          st,
          w,
          { x, y: inner.y + (inner.h - o.h) / 2, w: ow, h: o.h, est: inner.est || o.est },
          ctx,
          depth + 1,
        )
        x += ow
      }
      return
    }
    case 'UniformGridPanel': {
      if (!list.length) return
      const cols = Math.max(1, ...list.map((k) => (k.Slot?.Column ?? 0) + 1))
      const rows = Math.max(1, ...list.map((k) => (k.Slot?.Row ?? 0) + 1))
      const cw = inner.w / cols
      const rh = inner.h / rows
      for (const c of list)
        placeIn(
          c,
          st,
          w,
          {
            x: inner.x + (c.Slot?.Column ?? 0) * cw,
            y: inner.y + (c.Slot?.Row ?? 0) * rh,
            w: cw,
            h: rh,
            est: inner.est,
          },
          ctx,
          depth + 1,
        )
      return
    }
    case 'ListView':
    case 'TileView':
    case 'DynamicEntryBox':
    case 'UserWidget':
      // 条目和子控件里的控件在画布上不能单独选中，截图的位置表里也没有它们
      return
    default: {
      const shown = w.Type === 'WidgetSwitcher' ? switcherChild(w) : list
      for (const c of shown)
        placeIn(c, w.Type === 'WidgetSwitcher' ? 'WidgetSwitcherSlot' : st, w, inner, ctx, depth + 1)
    }
  }
}

/** CanvasPanelSlot 的外壳：锚点 + 偏移，不拉伸的轴再按对齐点挪（和 umg-render 的 translate 百分比一致） */
function canvasArea(c: Widget, parent: Widget, P: Box, ctx: Ctx): Box {
  const slot = c.Slot ?? {}
  const L = slot.LayoutData ?? {}
  const o = L.Offsets ?? {}
  const a = L.Anchors ?? { Minimum: { X: 0, Y: 0 }, Maximum: { X: 0, Y: 0 } }
  const al = L.Alignment ?? { X: 0, Y: 0 }
  let auto: Size | undefined
  const autoSize = () => (auto ??= outerContent(c, parent, ctx))
  const axis = (k: 'X' | 'Y') => {
    const size = k === 'X' ? P.w : P.h
    const min = Number(a.Minimum?.[k]) || 0
    const max = Number(a.Maximum?.[k]) || 0
    const start = Number(o[k === 'X' ? 'Left' : 'Top']) || 0
    const end = Number(o[k === 'X' ? 'Right' : 'Bottom']) || 0
    const pos = min * size + start
    if (min !== max) return { pos, len: Math.max(0, (max - min) * size - start - end), est: false }
    const auto = !!slot.bAutoSize
    const len = auto ? (k === 'X' ? autoSize().w : autoSize().h) : Math.max(0, end)
    return { pos: pos - (Number(al[k]) || 0) * len, len, est: auto && !!autoSize().est }
  }
  const x = axis('X')
  const y = axis('Y')
  return { x: P.x + x.pos, y: P.y + y.pos, w: x.len, h: y.len, est: P.est || x.est || y.est }
}

/** 横排 / 竖排：Auto 的按内容，Fill 的按 Value 分剩下的；另一个方向撑满 */
function boxLayout(w: Widget, list: Widget[], B: Box, row: boolean, ctx: Ctx, depth: number) {
  const st = WIDGETS[w.Type]?.slot
  const main = row ? B.w : B.h
  const items = list.map((c) => {
    const fill = c.Slot?.Size?.SizeRule === 'Fill'
    const o = fill ? undefined : outerContent(c, w, ctx, row ? undefined : B.w)
    // Fill 的外壳 flex-basis 是 0，但插槽的内边距不参与伸缩：先从剩余空间里扣掉，再按比例分
    const p = slotPad(st, c.Slot, w)
    const padMain = row ? p.l + p.r : p.t + p.b
    return {
      c,
      fill,
      weight: Number(c.Slot?.Size?.Value ?? 1) || 0,
      base: o ? (row ? o.w : o.h) : padMain,
      est: !!o?.est,
    }
  })
  const used = items.reduce((n, i) => n + i.base, 0)
  const total = items.reduce((n, i) => n + (i.fill ? i.weight : 0), 0)
  const free = Math.max(0, main - used)
  let est = !!B.est
  let at = row ? B.x : B.y
  for (const i of items) {
    // flex-grow 合计不到 1 时只分走对应比例的剩余空间（CSS 的规则）
    const len = i.fill ? i.base + (total > 0 ? (free * i.weight) / Math.max(1, total) : 0) : i.base
    const area: Box = row ? { x: at, y: B.y, w: len, h: B.h, est } : { x: B.x, y: at, w: B.w, h: len, est }
    // Fill 的大小由前面 Auto 的估算决定，也跟着标
    if (i.fill && items.some((x) => x.est)) area.est = true
    else if (i.est) area.est = true
    placeIn(i.c, st, w, area, ctx, depth + 1)
    at += len
    est ||= i.est
  }
}

/** ScrollBox（单向排开不换行）和 WrapBox（排满一行换行，行高取这一行最高的） */
function flowLayout(w: Widget, list: Widget[], B: Box, ctx: Ctx, depth: number) {
  const p = w.Properties ?? {}
  const st = WIDGETS[w.Type]?.slot
  const wrap = w.Type === 'WrapBox'
  const row = wrap ? p.Orientation !== 'Orient_Vertical' : p.Orientation === 'Orient_Horizontal'
  const gx = wrap ? Number(p.InnerSlotPadding?.X) || 0 : 0
  const gy = wrap ? Number(p.InnerSlotPadding?.Y) || 0 : 0
  const gapMain = row ? gx : gy
  const gapCross = row ? gy : gx
  const limit = row ? B.w : B.h
  const sizes = list.map((c) => outerContent(c, w, ctx, row ? undefined : B.w))
  // 分行
  const lines: number[][] = []
  let cur: number[] = []
  let len = 0
  sizes.forEach((s, i) => {
    const m = row ? s.w : s.h
    if (wrap && cur.length && len + gapMain + m > limit + 0.01) {
      lines.push(cur)
      cur = []
      len = 0
    }
    len += (cur.length ? gapMain : 0) + m
    cur.push(i)
  })
  if (cur.length) lines.push(cur)
  let cross = row ? B.y : B.x
  for (const line of lines) {
    // 不换行时另一个方向撑满（align-items: stretch）；换行时撑满这一行
    const lineCross = wrap ? Math.max(...line.map((i) => (row ? sizes[i].h : sizes[i].w))) : row ? B.h : B.w
    const used = line.reduce((n, i) => n + (row ? sizes[i].w : sizes[i].h), 0) + gapMain * (line.length - 1)
    const grow = line.filter((i) => list[i].Slot?.bFillEmptySpace)
    const extra = wrap && grow.length ? Math.max(0, limit - used) / grow.length : 0
    let at = row ? B.x : B.y
    for (const i of line) {
      const m = (row ? sizes[i].w : sizes[i].h) + (grow.includes(i) ? extra : 0)
      const est = !!B.est || sizes.some((s) => s.est)
      const area: Box = row
        ? { x: at, y: cross, w: m, h: lineCross, est }
        : { x: cross, y: at, w: lineCross, h: m, est }
      placeIn(list[i], st, w, area, ctx, depth + 1)
      at += m + gapMain
    }
    cross += lineCross + gapCross
  }
}

// ---------- 变换 ----------

type Mat = [number, number, number, number, number, number]
const ID: Mat = [1, 0, 0, 1, 0, 0]
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

/** RenderTransform（绕 Pivot 平移、旋转、缩放），和 umg-render 的 CSS transform 顺序一致 */
function ownTransform(w: Widget, r: LayoutRect): Mat | undefined {
  const tr = w.Properties?.RenderTransform
  if (!tr) return undefined
  const tx = Number(tr.Translation?.X) || 0
  const ty = Number(tr.Translation?.Y) || 0
  const a = ((Number(tr.Angle) || 0) * Math.PI) / 180
  const sx = tr.Scale?.X ?? 1
  const sy = tr.Scale?.Y ?? 1
  if (!tx && !ty && !a && sx === 1 && sy === 1) return undefined
  const pv = w.Properties?.RenderTransformPivot ?? { X: 0.5, Y: 0.5 }
  const ox = r.x + r.w * pv.X
  const oy = r.y + r.h * pv.Y
  let m: Mat = [1, 0, 0, 1, ox, oy]
  m = mul(m, [1, 0, 0, 1, tx, ty])
  m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])
  m = mul(m, [sx, 0, 0, sy, 0, 0])
  return mul(m, [1, 0, 0, 1, -ox, -oy])
}

function bounds(m: Mat, r: LayoutRect): LayoutRect {
  const pts = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { ...r, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** 布局算完后按树的顺序套上各层的变换：父控件的变换也带着子控件走 */
function applyTransforms(root: Widget, rects: LayoutRect[]) {
  let i = 0
  const visit = (w: Widget, m: Mat, depth: number) => {
    const r = rects[i++]
    if (!r) return
    const own = ownTransform(w, r)
    const mm = own ? mul(m, own) : m
    if (mm !== ID) rects[i - 1] = bounds(mm, r)
    if (depth > 40 || ['ListView', 'TileView', 'DynamicEntryBox', 'UserWidget'].includes(w.Type)) return
    const shown = w.Type === 'WidgetSwitcher' ? switcherChild(w) : kids(w)
    for (const c of shown) visit(c, mm, depth + 1)
  }
  visit(root, ID, 0)
}

// ---------- 入口 ----------

/**
 * 算出一棵 UMG 树（主界面或某个子控件）里每个控件的位置，顺序和截图的位置表一样（树的先序）。
 * 网页设计返回 undefined：网页的 flex / 文字排版交给浏览器（截图）。
 */
export function layoutTree(
  root: Widget,
  o: { size: { X: number; Y: number }; components: Component[]; data?: DesignData },
): LayoutRect[] | undefined {
  let web = false
  const scan = (w: Widget) => {
    if (isWebType(w.Type)) web = true
    for (const c of w.Children ?? []) scan(c)
  }
  scan(root)
  if (web) return undefined
  if (!visible(root)) return []
  const ctx: Ctx = { comps: new Map(o.components.map((c) => [c.Name, c])), data: o.data, out: [] }
  placeIn(root, undefined, undefined, { x: 0, y: 0, w: o.size.X, h: o.size.Y }, ctx, 0)
  applyTransforms(root, ctx.out)
  return ctx.out
}

/** 给 AI 看的一行：名字（类型）x,y 宽×高，估算的带「≈」 */
export function rectLine(r: LayoutRect) {
  const n = (v: number) => Math.round(v)
  return `${r.name}（${r.type}）${r.est ? '≈' : ''}${n(r.x)},${n(r.y)} ${n(r.w)}×${n(r.h)}`
}

/** 改动前后的位置对比：新出现的、位置或大小变了的控件（按名字对） */
export function layoutChanges(before: LayoutRect[] | undefined, after: LayoutRect[]) {
  const old = new Map((before ?? []).map((r) => [r.name, r]))
  const moved = (a: LayoutRect, b: LayoutRect) =>
    Math.abs(a.x - b.x) >= 0.5 || Math.abs(a.y - b.y) >= 0.5 || Math.abs(a.w - b.w) >= 0.5 || Math.abs(a.h - b.h) >= 0.5
  return after.filter((r) => {
    const b = old.get(r.name)
    return !b || moved(b, r)
  })
}
