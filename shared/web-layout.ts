import type { Component, Widget } from './umg.ts'
import { propsAt, type Device } from './web.ts'
import { measureText, type LayoutRect } from './umg-layout.ts'

/**
 * 网页设计不开页面算出每个控件的位置（设计稿像素），和截图的位置表同一个口径（控件本体的外框、树的先序）。
 * 照 shared/web.ts 的 webCss 一条条算 CSS flex：Frame 是 flex 容器（Direction、Gap、Padding、AlignItems、
 * JustifyContent、Wrap、边框算在宽高里），子控件宽高是像素 / fill / auto，绝对定位按 Pin 贴角，平板 / 手机用断点里的属性。
 * 算不准的标 est：文字（字宽表估）、按钮和输入框（浏览器默认尺寸）、没写宽高的图片（按图片原始尺寸）、
 * 放不下时的收缩、换行，以及被它们推着走的控件。改 web.ts 的样式规则时同步改这里，对照分片会先报出来
 */

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
  device: Device
  images: Map<string, { width: number; height: number }>
  out: LayoutRect[]
}
/** 一个要排版的控件：子控件引用（UserWidget）换成子控件的根，名字和类型记引用它的那个 */
interface Node {
  w: Widget
  p: Record<string, any>
  name: string
  type: string
  slot: any
  kids: Node[]
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const padOf = (m: any) =>
  m && typeof m === 'object'
    ? { l: Number(m.Left) || 0, t: Number(m.Top) || 0, r: Number(m.Right) || 0, b: Number(m.Bottom) || 0 }
    : { l: 0, t: 0, r: 0, b: 0 }

function build(w: Widget, ctx: Ctx, depth: number): Node | undefined {
  if (w.Type === 'UserWidget') {
    const c = ctx.comps.get(w.Class ?? '')
    // 找不到子控件：画布上是一块带内边距的占位（12px 16px + 一行 11px 的字）
    if (!c || depth > 6)
      return {
        w,
        p: { Padding: { Left: 16, Top: 12, Right: 16, Bottom: 12 }, __placeholder: w.Class || 'UserWidget' },
        name: w.Name,
        type: w.Type,
        slot: w.Slot,
        kids: [],
      }
    const root = build({ ...c.Root, Slot: w.Slot }, ctx, depth + 1)
    return root && { ...root, name: w.Name, type: w.Type, slot: w.Slot }
  }
  const p = propsAt(w.Properties, ctx.device)
  if (p.Visibility === 'Collapsed') return undefined
  return {
    w,
    p,
    name: w.Name,
    type: w.Type,
    slot: w.Slot,
    kids: (w.Children ?? []).map((c) => build(c, ctx, depth)).filter((x): x is Node => !!x),
  }
}

const absolute = (n: Node) => n.slot?.Position === 'absolute'
const border = (n: Node) => (['Frame', 'WebButton', 'Input'].includes(n.type) ? Number(n.p.BorderWidth) || 0 : 0)
/** 内边距 + 边框：box-sizing 是 border-box，宽高里含着它们 */
const inset = (n: Node) => {
  const pd = ['Frame', 'WebButton', 'Input'].includes(n.type) || n.p.__placeholder ? padOf(n.p.Padding) : padOf(null)
  const b = border(n)
  return { l: pd.l + b, t: pd.t + b, r: pd.r + b, b: pd.b + b }
}

/** 文字类控件的字号、行高（web.ts 里 Text 默认 16 / 1.5，按钮、输入框默认 14、行高按 normal 约 1.2） */
function textBox(n: Node, width?: number): Size {
  const p = n.p
  if (n.p.__placeholder) {
    const m = measureText(String(n.p.__placeholder), { px: 11, lineHeight: 1.2 })
    return { w: m.w, h: m.h, est: true }
  }
  const px = Number(p.FontSize) || (n.type === 'Text' ? 16 : 14)
  // 按钮、输入框的行高是浏览器的 normal：Chromium 里系统字体约 1.15 倍字号
  const lh = n.type === 'Text' ? Number(p.LineHeight) || 1.5 : 1.15
  const ls = Number(p.LetterSpacing) ? Number(p.LetterSpacing) / px : 0
  const text = n.type === 'Input' ? String(p.Value || p.Placeholder || '') : String(p.Text ?? '')
  const m = measureText(text, { px, lineHeight: lh, letterSpacingEm: ls, wrap: n.type === 'Text', width })
  return { w: m.w, h: Math.max(m.h, px * lh), est: true }
}

/** 控件按内容的尺寸（border-box）；width 是已经定下的宽度（文字按它折行、竖排的子控件按它拉伸） */
function intrinsic(n: Node, ctx: Ctx, width?: number): Size {
  const p = n.p
  const fw = num(p.Width)
  const fh = num(p.Height)
  const ins = inset(n)
  const W = fw ?? width
  const innerW = W === undefined ? undefined : Math.max(0, W - ins.l - ins.r)
  let c: Size
  switch (n.type) {
    case 'Frame':
      c = n.p.__placeholder ? textBox(n) : frameContent(n, ctx, innerW)
      break
    case 'Text':
      c = textBox(n, innerW)
      break
    case 'WebButton':
      c = textBox(n)
      break
    case 'Input': {
      // 浏览器默认的输入框大小（size=20，Chromium 里约 12.7 倍字号宽；多行框默认两行）：只能估
      const px = Number(p.FontSize) || 14
      c = { w: px * 12.7, h: px * 1.15 * (p.Multiline ? 2 : 1), est: true }
      break
    }
    case 'Picture': {
      const id = typeof p.Src === 'string' && p.Src.startsWith('img:') ? p.Src.slice(4) : ''
      const img = id ? ctx.images.get(id) : undefined
      if (!img) c = { w: 0, h: 0 }
      else if (fw !== undefined && fh === undefined) c = { w: fw, h: (fw * img.height) / img.width, est: true }
      else if (fh !== undefined && fw === undefined) c = { w: (fh * img.width) / img.height, h: fh, est: true }
      else c = { w: img.width, h: img.height, est: true }
      return { w: fw ?? c.w, h: fh ?? c.h, est: c.est && (fw === undefined || fh === undefined) }
    }
    case 'Divider': {
      const t = Number(p.Thickness) || 1
      return p.Vertical ? { w: t, h: fh ?? 0 } : { w: fw ?? 0, h: t }
    }
    default:
      c = { w: 0, h: 0 }
  }
  return {
    w: fw ?? c.w + ins.l + ins.r,
    h: fh ?? c.h + ins.t + ins.b,
    est: c.est && (fw === undefined || fh === undefined),
  }
}

/** Frame 里排好的子控件按内容的总尺寸（不含自己的内边距） */
function frameContent(n: Node, ctx: Ctx, width?: number): Size {
  const row = n.p.Direction === 'row'
  const gap = Number(n.p.Gap) || 0
  const flow = n.kids.filter((k) => !absolute(k))
  // 横排、可以换行、宽度定了：按宽度分行，高度是各行最高的加起来
  if (row && n.p.Wrap && width !== undefined) {
    let lineW = 0
    let lineH = 0
    let total = 0
    let maxW = 0
    let lines = 0
    for (const k of flow) {
      const s = intrinsic(k, ctx)
      const kw = isFill(k, 'Width') ? 0 : s.w
      if (lines && lineW > 0 && lineW + gap + kw > width + 0.01) {
        total += lineH + gap
        maxW = Math.max(maxW, lineW)
        lineW = 0
        lineH = 0
      }
      if (!lines) lines = 1
      lineW += (lineW > 0 ? gap : 0) + kw
      lineH = Math.max(lineH, s.h)
    }
    return { w: Math.max(maxW, lineW), h: total + lineH, est: true }
  }
  let main = 0
  let cross = 0
  let est = false
  flow.forEach((k, i) => {
    // 竖排里子控件横向拉伸到父控件的宽：文字按这个宽度折行
    const stretch = !row && width !== undefined && crossStretch(k, n)
    const s = intrinsic(k, ctx, stretch ? width : undefined)
    const kw = isFill(k, 'Width') && row ? 0 : s.w
    const kh = isFill(k, 'Height') && !row ? 0 : s.h
    main += (row ? kw : kh) + (i ? gap : 0)
    cross = Math.max(cross, row ? kh : stretch ? (width ?? s.w) : kw)
    est ||= !!s.est
  })
  return row ? { w: main, h: cross, est } : { w: cross, h: main, est }
}

const isFill = (k: Node, axis: 'Width' | 'Height') => k.p[axis] === 'fill'
const ALIGN_SELF: Record<string, string> = { start: 'start', center: 'center', end: 'end', stretch: 'stretch' }
/** 在父控件的交叉方向上拉伸：写了 fill，或者宽高没写、父控件 AlignItems 是默认的 stretch（AlignSelf 能单独改） */
function crossStretch(k: Node, parent: Node) {
  const row = parent.p.Direction === 'row'
  const axis = row ? 'Height' : 'Width'
  if (k.type === 'Divider') return true
  const self = k.slot?.AlignSelf && k.slot.AlignSelf !== 'auto' ? ALIGN_SELF[k.slot.AlignSelf] : undefined
  if (k.p[axis] === 'fill') return true
  if (num(k.p[axis]) !== undefined) return false
  return (self ?? parent.p.AlignItems ?? 'stretch') === 'stretch'
}
function crossAlign(k: Node, parent: Node) {
  const self = k.slot?.AlignSelf && k.slot.AlignSelf !== 'auto' ? ALIGN_SELF[k.slot.AlignSelf] : undefined
  return self ?? parent.p.AlignItems ?? 'stretch'
}

function place(n: Node, box: Box, ctx: Ctx, depth: number) {
  ctx.out.push({
    name: n.name,
    type: n.type,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    ...(box.est ? { est: true } : {}),
  })
  if (n.type !== 'Frame' || depth > 40) return
  const ins = inset(n)
  const C: Box = {
    x: box.x + ins.l,
    y: box.y + ins.t,
    w: Math.max(0, box.w - ins.l - ins.r),
    h: Math.max(0, box.h - ins.t - ins.b),
    est: box.est,
  }
  const row = n.p.Direction === 'row'
  const gap = Number(n.p.Gap) || 0
  const flow = n.kids.filter((k) => !absolute(k))
  // 先按内容定每个子控件在排列方向上的基准尺寸，交叉方向上要拉伸的先按容器的宽高
  const items = flow.map((k) => {
    const stretch = crossStretch(k, n)
    const crossFixed = num(k.p[row ? 'Height' : 'Width'])
    const crossSize = stretch ? (row ? C.h : C.w) : undefined
    const s = intrinsic(k, ctx, !row ? (crossSize ?? crossFixed) : undefined)
    const fill = isFill(k, row ? 'Width' : 'Height')
    const fixedMain = num(k.p[row ? 'Width' : 'Height'])
    // fill 是 flex: 1 1 0，但 border-box 的内边距和边框不能缩没：先占着，剩下的空间再平分
    const ki = inset(k)
    const base = fill ? (row ? ki.l + ki.r : ki.t + ki.b) : (fixedMain ?? (row ? s.w : s.h))
    return { k, s, stretch, fill, fixedMain, base }
  })
  const mainSize = row ? C.w : C.h
  const wrap = !!n.p.Wrap
  // 分行（不换行就是一行）
  const lines: (typeof items)[] = []
  let cur: typeof items = []
  let used = 0
  for (const it of items) {
    if (wrap && cur.length && used + gap + it.base > mainSize + 0.01) {
      lines.push(cur)
      cur = []
      used = 0
    }
    used += (cur.length ? gap : 0) + it.base
    cur.push(it)
  }
  if (cur.length) lines.push(cur)
  let crossAt = row ? C.y : C.x
  for (const line of lines) {
    const total = line.reduce((t, it) => t + it.base, 0) + gap * (line.length - 1)
    let free = mainSize - total
    const fills = line.filter((it) => it.fill)
    let est = !!C.est || line.some((it) => it.s.est) || (wrap && lines.length > 1)
    const sizes = line.map((it) => it.base)
    if (free > 0 && fills.length) {
      // flex: 1 1 0 的平分剩下的空间
      line.forEach((it, i) => it.fill && (sizes[i] = it.base + free / fills.length))
      free = 0
    } else if (free < 0) {
      // 放不下：没写宽高的（flex-shrink 1）按基准尺寸成比例收缩；写了像素的不缩。浏览器还受最小内容宽度限制，只能估
      const shrinkable = line.map((it) => (it.fixedMain === undefined && !it.fill ? it.base : 0))
      const sum = shrinkable.reduce((a, b) => a + b, 0)
      if (sum > 0) {
        line.forEach((_, i) => (sizes[i] = Math.max(0, sizes[i] + (free * shrinkable[i]) / sum)))
        free = 0
        est = true
      }
    }
    // 这一行在交叉方向上的尺寸：不换行时就是容器；换行时取这一行最高的
    const lineCross = wrap
      ? Math.max(
          0,
          ...line.map((it, i) =>
            row
              ? it.stretch
                ? intrinsic(it.k, ctx, sizes[i]).h
                : (num(it.k.p.Height) ?? intrinsic(it.k, ctx, sizes[i]).h)
              : (num(it.k.p.Width) ?? it.s.w),
          ),
        )
      : row
        ? C.h
        : C.w
    // JustifyContent：剩下的空间放在哪
    const jc = n.p.JustifyContent ?? 'start'
    const count = line.length
    let lead = 0
    let between = 0
    if (free > 0) {
      if (jc === 'center') lead = free / 2
      else if (jc === 'end') lead = free
      else if (jc === 'between' && count > 1) between = free / (count - 1)
      else if (jc === 'around') {
        between = free / count
        lead = between / 2
      } else if (jc === 'evenly') {
        between = free / (count + 1)
        lead = between
      }
    }
    let at = (row ? C.x : C.y) + lead
    line.forEach((it, i) => {
      const m = sizes[i]
      // 交叉方向：拉伸的用这一行的尺寸，否则按内容，再按对齐摆
      let c: number
      if (row) c = it.stretch ? lineCross : (num(it.k.p.Height) ?? intrinsic(it.k, ctx, m).h)
      else c = it.stretch ? lineCross : (num(it.k.p.Width) ?? it.s.w)
      // 竖排里高度没写的：按定下来的宽度重新量（文字折行后变高）
      const mainLen = !row && !it.fill && it.fixedMain === undefined ? intrinsic(it.k, ctx, c).h : m
      const align = it.stretch ? 'stretch' : crossAlign(it.k, n)
      const off = align === 'center' ? (lineCross - c) / 2 : align === 'end' ? lineCross - c : 0
      const b: Box = row
        ? { x: at, y: crossAt + off, w: m, h: c, est }
        : { x: crossAt + off, y: at, w: c, h: mainLen, est }
      place(it.k, b, ctx, depth + 1)
      at += (row ? m : mainLen) + gap + between
    })
    crossAt += lineCross + gap
  }
  // 绝对定位的：贴在父控件的内边距框（padding box）上，Pin 是哪个角，X、Y 是离那个角的距离
  const pb: Box = {
    x: box.x + border(n),
    y: box.y + border(n),
    w: box.w - 2 * border(n),
    h: box.h - 2 * border(n),
  }
  for (const k of n.kids.filter(absolute)) {
    const s = intrinsic(k, ctx)
    const w = k.p.Width === 'fill' ? pb.w : s.w
    const h = k.p.Height === 'fill' ? pb.h : s.h
    const pin = String(k.slot?.Pin ?? 'top-left')
    const X = Number(k.slot?.X) || 0
    const Y = Number(k.slot?.Y) || 0
    let x: number
    let y: number
    if (pin === 'center') {
      x = pb.x + pb.w / 2 + X - w / 2
      y = pb.y + pb.h / 2 + Y - h / 2
    } else {
      x = pin.endsWith('right') ? pb.x + pb.w - X - w : pb.x + X
      y = pin.startsWith('bottom') ? pb.y + pb.h - Y - h : pb.y + Y
    }
    place(k, { x, y, w, h, est: !!box.est || !!s.est }, ctx, depth + 1)
  }
}

/**
 * 算出一棵网页控件树（主界面或某个子控件）里每个控件的位置。size 是画布的宽高（桌面是设计稿宽高，平板 / 手机是那个宽度）
 */
export function webLayoutTree(
  root: Widget,
  o: {
    size: { X: number; Y: number }
    components: Component[]
    device?: Device
    images?: { id: string; width: number; height: number }[]
  },
): LayoutRect[] {
  const ctx: Ctx = {
    comps: new Map(o.components.map((c) => [c.Name, c])),
    device: o.device ?? 'desktop',
    images: new Map((o.images ?? []).map((i) => [i.id, { width: i.width, height: i.height }])),
    out: [],
  }
  const n = build(root, ctx, 0)
  if (!n) return []
  // 根控件没有父控件：fill 是画布的 100%，没写就按内容
  const s = intrinsic(n, ctx, n.p.Width === 'fill' ? o.size.X : undefined)
  const w = n.p.Width === 'fill' ? o.size.X : (num(n.p.Width) ?? s.w)
  const h = n.p.Height === 'fill' ? o.size.Y : (num(n.p.Height) ?? intrinsic(n, ctx, w).h)
  place(n, { x: 0, y: 0, w, h, est: !!s.est && n.p.Height !== 'fill' && num(n.p.Height) === undefined }, ctx, 0)
  return ctx.out
}
