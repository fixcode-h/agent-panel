import { resize, type Img } from '../raster.ts'
import type { Box, ElementKind, RepeatGroup, RestoreElement } from './schema.ts'
import { findGroups } from './grid.ts'
import { boxColor, foreground, type Masks } from './pixels.ts'

/**
 * 拆解：从原画里找出元素的框（纯算法，不用模型）。模型读坐标不准（误差十几到几十像素），
 * 所以框只从这里来；模型只给框起类型和名字、读文字（见 label.ts）。
 *
 * 1. 前景：和大范围模糊后的「局部背景」差得多、或者梯度大的像素（平滑渐变的背景不算前景）
 * 2. 框形容器：强边缘里找长的横线、竖线，四条边能围成矩形的是面板、按钮、格子
 * 3. 散点：前景去掉容器边框那一圈，连通块按距离并成团；单色、矮、横着排开的是文字，其余是图标或装饰
 * 4. 重复组：大小一样、等间距排成行列的（背包格子），见 grid.ts
 * 5. 框边吸附到附近梯度最大的位置（亚像素级的修正交给用户拖）
 * 原画很大时先缩到长边 1600 再找（快），框按比例放回原画像素
 */

export interface DetectResult {
  elements: RestoreElement[]
  groups: RepeatGroup[]
  /** 前景像素里被框住的比例（不算背景） */
  coverage: number
  /** 没被框住、又成片的前景（给决策卡提醒用） */
  uncovered: Box[]
}

const WORK_SIDE = 1600

export function detectElements(src: Img, o: { idPrefix?: string } = {}): DetectResult {
  const k = Math.min(1, WORK_SIDE / Math.max(src.width, src.height))
  const img = k < 1 ? resize(src, Math.round(src.width * k), Math.round(src.height * k)) : src
  const { width: W, height: H } = img
  const m = foreground(img)
  const rects = findRects(m, W, H)
  const blobs = findBlobs(img, m, rects, W, H)
  const prefix = o.idPrefix ?? 'e'
  let n = 0
  const id = () => `${prefix}${++n}`
  const out: RestoreElement[] = [
    {
      id: id(),
      kind: 'background',
      name: 'Bg_Main',
      box: { x: 0, y: 0, w: src.width, h: src.height },
      confidence: 1,
      source: 'detect',
    },
  ]
  const back = (b: Box): Box => {
    const r = { x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k }
    return k < 1 ? snap(src, r) : snap(src, r, 2)
  }
  for (const r of rects)
    out.push({ id: id(), kind: r.kind, name: '', box: back(r.box), confidence: r.conf, source: 'detect' })
  for (const b of blobs)
    out.push({
      id: id(),
      kind: b.kind,
      name: '',
      box: roundBox({ x: b.box.x / k, y: b.box.y / k, w: b.box.w / k, h: b.box.h / k }),
      confidence: b.conf,
      source: 'detect',
      ...(b.kind === 'text'
        ? { text: { content: '', px: Math.round(b.box.h / k), color: b.color, align: 'left' as const, bold: false } }
        : {}),
    })
  const groups = findGroups(out, prefix)
  nameAll(out)
  for (const e of out) if (e.kind === 'text' && e.text) e.text.align = alignIn(e, out)
  const { coverage, uncovered } = coverageOf(m, W, H, out, k)
  return { elements: out, groups, coverage, uncovered }
}

// ---- 框形容器 ----

interface Seg {
  /** 横线：y 是线的位置，a..b 是 x 范围；竖线反过来 */
  at: number
  a: number
  b: number
}
interface Rect {
  box: Box
  kind: ElementKind
  conf: number
  /** 四条边上最长的一段断口（像素）：两排格子拼出来的假框，竖边在行距那里断一截 */
  gap?: number
}

/** 一条边上最长的一段没有边缘的长度（允许上下各 1 像素） */
function lineGap(e: Uint8Array, W: number, H: number, horiz: boolean, at: number, a: number, b: number) {
  let run = 0
  let worst = 0
  for (let t = Math.max(0, Math.round(a)); t <= Math.min((horiz ? W : H) - 1, Math.round(b)); t++) {
    let hit = false
    for (let d = -1; d <= 1 && !hit; d++) {
      const p = Math.round(at) + d
      if (p >= 0 && p < (horiz ? H : W)) hit = !!(horiz ? e[p * W + t] : e[t * W + p])
    }
    run = hit ? 0 : run + 1
    worst = Math.max(worst, run)
  }
  return worst
}

/** 一条边上有边缘的比例：沿着这条线（允许上下各 2 像素）数强边缘 */
function lineCover(e: Uint8Array, W: number, H: number, horiz: boolean, at: number, a: number, b: number) {
  let hit = 0
  let all = 0
  for (let t = Math.max(0, Math.round(a)); t <= Math.min((horiz ? W : H) - 1, Math.round(b)); t++) {
    all++
    for (let d = -2; d <= 2; d++) {
      const p = Math.round(at) + d
      if (p < 0 || p >= (horiz ? H : W)) continue
      if (horiz ? e[p * W + t] : e[t * W + p]) {
        hit++
        break
      }
    }
  }
  return all ? hit / all : 0
}

/** 强边缘里的长直线：一行（列）里连续的边缘像素，长度够的记下，相邻行合并成一条 */
function segments(e: Uint8Array, W: number, H: number, horiz: boolean, minLen: number): Seg[] {
  const lines: Seg[] = []
  const outer = horiz ? H : W
  const inner = horiz ? W : H
  for (let i = 0; i < outer; i++) {
    let start = -1
    let gap = 0
    for (let j = 0; j <= inner; j++) {
      const on = j < inner && (horiz ? e[i * W + j] : e[j * W + i])
      if (on) {
        if (start < 0) start = j
        gap = 0
      } else if (start >= 0) {
        // 允许 2 像素的断口（抗锯齿、花纹）
        if (++gap > 2 || j === inner) {
          const end = j - gap
          if (end - start + 1 >= minLen) lines.push({ at: i, a: start, b: end })
          start = -1
          gap = 0
        }
      }
    }
  }
  // 相邻几行上同一条线（线有粗细）合成一条，位置取中间
  lines.sort((p, q) => p.a - q.a || p.at - q.at)
  const merged: (Seg & { n: number })[] = []
  for (const s of lines) {
    const hit = merged.find((m) => s.at - (m.at + m.n - 1) <= 1 && s.at >= m.at && overlap(m.a, m.b, s.a, s.b) > 0.8)
    if (hit) {
      hit.a = Math.min(hit.a, s.a)
      hit.b = Math.max(hit.b, s.b)
      hit.n = s.at - hit.at + 1
    } else merged.push({ ...s, n: 1 })
  }
  return merged.map((m) => ({ at: m.at + (m.n - 1) / 2, a: m.a, b: m.b }))
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, Math.min(a1 - a0, b1 - b0))

function findRects(m: Masks, W: number, H: number): Rect[] {
  const minSide = Math.max(14, Math.round(Math.min(W, H) * 0.018))
  const hs = segments(m.edge, W, H, true, minSide)
  const vs = segments(m.edge, W, H, false, minSide)
  const found: Rect[] = []
  // 两条横线做上下边，两端有竖线（圆角会让线短一截：端点允许差 max(10, 6%)）
  for (let i = 0; i < hs.length; i++)
    for (let j = 0; j < hs.length; j++) {
      const top = hs[i]
      const bot = hs[j]
      if (bot.at - top.at < minSide) continue
      if (overlap(top.a, top.b, bot.a, bot.b) < 0.85) continue
      const ex0 = Math.min(top.a, bot.a)
      const ex1 = Math.max(top.b, bot.b)
      const h = bot.at - top.at
      if (ex1 - ex0 < minSide) continue
      const tol = Math.max(10, 0.06 * Math.min(ex1 - ex0, h))
      // 左右两条竖边：横线两端因为圆角会短一截，竖边才是框真正的左右沿，取离端点最近的那条
      const side = (at: number) =>
        vs
          .filter((v) => Math.abs(v.at - at) <= tol && v.a <= top.at + tol + h * 0.3 && v.b >= bot.at - tol - h * 0.3)
          .sort((p, q) => Math.abs(p.at - at) - Math.abs(q.at - at))[0]
      const left = side(ex0)
      const right = side(ex1)
      if (!left || !right) continue
      const x0 = Math.min(ex0, left.at)
      const x1 = Math.max(ex1, right.at)
      const w = x1 - x0
      // 四条边都量一遍覆盖率，差的不要（两排图标的上下沿会凑出假矩形）
      const c = [
        lineCover(m.edge, W, H, true, top.at, x0 + tol, x1 - tol),
        lineCover(m.edge, W, H, true, bot.at, x0 + tol, x1 - tol),
        lineCover(m.edge, W, H, false, x0, top.at + tol, bot.at - tol),
        lineCover(m.edge, W, H, false, x1, top.at + tol, bot.at - tol),
      ]
      const conf = Math.min(...c)
      if (conf < 0.55) continue
      // 断口只在去掉圆角后量：圆角半径一般不超过短边的一成
      const rc = Math.min(tol, Math.max(3, 0.1 * Math.min(w, h)))
      // 四个角都要「拐得过来」：横边和竖边在角上都有一截。借别的东西的边凑出来的框（大面板的顶边配一排格子的顶边）
      // 总有一个角是空的
      const arm = Math.max(6, Math.min(40, 0.15 * Math.min(w, h)))
      const corner = Math.min(
        lineCover(m.edge, W, H, true, top.at, x0 + rc, x0 + rc + arm),
        lineCover(m.edge, W, H, true, top.at, x1 - rc - arm, x1 - rc),
        lineCover(m.edge, W, H, true, bot.at, x0 + rc, x0 + rc + arm),
        lineCover(m.edge, W, H, true, bot.at, x1 - rc - arm, x1 - rc),
        lineCover(m.edge, W, H, false, x0, top.at + rc, top.at + rc + arm),
        lineCover(m.edge, W, H, false, x0, bot.at - rc - arm, bot.at - rc),
        lineCover(m.edge, W, H, false, x1, top.at + rc, top.at + rc + arm),
        lineCover(m.edge, W, H, false, x1, bot.at - rc - arm, bot.at - rc),
      )
      // 胶囊形（货币栏、圆头按钮）：两头整个是半圆，竖边只剩中间一点，横边从半径以外才是直的
      const pill = () => {
        if (Math.max(w, h) < Math.min(w, h) * 2.5 || Math.min(w, h) > Math.min(W, H) * 0.1) return false
        const rr = Math.min(w, h) / 2
        const mid = top.at + h / 2
        return (
          Math.min(
            lineCover(m.edge, W, H, true, top.at, x0 + rr, x0 + rr + arm),
            lineCover(m.edge, W, H, true, top.at, x1 - rr - arm, x1 - rr),
            lineCover(m.edge, W, H, true, bot.at, x0 + rr, x0 + rr + arm),
            lineCover(m.edge, W, H, true, bot.at, x1 - rr - arm, x1 - rr),
            lineCover(m.edge, W, H, false, x0, mid - 2, mid + 2),
            lineCover(m.edge, W, H, false, x1, mid - 2, mid + 2),
          ) >= 0.6
        )
      }
      if (corner < 0.6 && !pill()) continue
      const gap = Math.max(
        lineGap(m.edge, W, H, true, top.at, x0 + rc, x1 - rc),
        lineGap(m.edge, W, H, true, bot.at, x0 + rc, x1 - rc),
        lineGap(m.edge, W, H, false, x0, top.at + rc, bot.at - rc),
        lineGap(m.edge, W, H, false, x1, top.at + rc, bot.at - rc),
      )
      found.push({ box: { x: x0, y: top.at, w, h }, kind: 'panel', conf: Math.min(1, 0.35 + conf * 0.65), gap })
    }
  // 上下几排格子：上排的底边配下排的顶边也能凑出一个比格子高一截的框（行距小，竖边覆盖率照样够）。
  // 认法：这个框里套着一个同宽的真框，而它的顶边（底边）正好是同一列另一个框的底边（顶边）
  const composite = (r: Rect) => {
    const d = Math.max(4, 0.04 * r.box.w)
    const col = found.filter((q) => q !== r && Math.abs(q.box.x - r.box.x) <= d && Math.abs(q.box.w - r.box.w) <= d)
    const bottom = (q: Rect) => q.box.y + q.box.h
    const inner = col.some((q) => q.box.y >= r.box.y - 1 && bottom(q) <= bottom(r) + 1 && q.box.h < r.box.h * 0.95)
    if (!inner) return false
    // 整个框正好由上下摞着的几个同宽框拼成（三排格子拼出一个三格高的）
    const stacked =
      col.some((p) => Math.abs(p.box.y - r.box.y) <= d && p.box.h < r.box.h * 0.8) &&
      col.some((p) => Math.abs(bottom(p) - bottom(r)) <= d && p.box.h < r.box.h * 0.8)
    if (stacked) return true
    return col.some(
      (p) =>
        (p.box.y < r.box.y - d && Math.abs(bottom(p) - r.box.y) <= d) ||
        (bottom(p) > bottom(r) + d && Math.abs(p.box.y - bottom(r)) <= d),
    )
  }
  const solid = found.filter((r) => !composite(r))
  found.length = 0
  found.push(...solid)
  // 同一个框的内外两道描边、相邻几条线凑出的近似框：留外面那个
  found.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
  const keep: Rect[] = []
  for (const r of found) {
    const dup = keep.find(
      (q) => iou(q.box, r.box) > 0.82 || nearSame(q.box, r.box, Math.max(8, 0.04 * Math.min(r.box.w, r.box.h))),
    )
    if (dup) {
      // 一般留外面那个（先排进来的大框）；但大框的边有断口、这个没有，说明大框是拼出来的，换成这个
      if ((r.gap ?? 0) + 3 < (dup.gap ?? 0)) {
        dup.box = r.box
        dup.gap = r.gap
      }
      dup.conf = Math.max(dup.conf, r.conf)
      continue
    }
    // 太小的方框多半是汉字的笔画（口、日这类），交给后面的文字行；细长的进度条除外
    const lo = Math.min(r.box.w, r.box.h)
    if (lo < Math.min(W, H) * 0.028 && Math.max(r.box.w, r.box.h) < lo * 5) continue
    // 整张图那么大的是画面边框，不算
    if (r.box.w > W * 0.97 && r.box.h > H * 0.97) continue
    keep.push(r)
  }
  for (const r of keep) r.kind = rectKind(r.box, W, H)
  // 格子里的小方框是图标自己的轮廓（卷轴、卡牌），不是又一层容器
  for (const r of keep)
    if (
      keep.some(
        (q) => q !== r && q.kind === 'slot' && inside(q.box, r.box) && r.box.w * r.box.h < q.box.w * q.box.h * 0.5,
      )
    )
      r.kind = 'icon'
  return keep
}

function rectKind(b: Box, W: number, H: number): ElementKind {
  const ratio = b.w / b.h
  if (b.h < H * 0.035 && ratio > 5) return 'bar'
  if (b.w * b.h > W * H * 0.08) return 'panel'
  if (ratio > 1.8 && ratio < 9 && b.h < H * 0.12) return 'button'
  if (ratio > 0.75 && ratio < 1.33 && b.w < W * 0.12) return 'slot'
  return 'panel'
}

const iou = (a: Box, b: Box) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const i = x * y
  return i / (a.w * a.h + b.w * b.h - i)
}
const inside = (outer: Box, b: Box) =>
  b.x >= outer.x - 1 && b.y >= outer.y - 1 && b.x + b.w <= outer.x + outer.w + 1 && b.y + b.h <= outer.y + outer.h + 1
const nearSame = (a: Box, b: Box, d: number) =>
  Math.abs(a.x - b.x) <= d &&
  Math.abs(a.y - b.y) <= d &&
  Math.abs(a.x + a.w - b.x - b.w) <= d &&
  Math.abs(a.y + a.h - b.y - b.h) <= d

// ---- 散点：图标、文字、装饰 ----

interface Blob {
  box: Box
  kind: ElementKind
  conf: number
  color: string
}

function findBlobs(img: Img, m: Masks, rects: Rect[], W: number, H: number): Blob[] {
  // 容器的边框那一圈不算前景：不然格子里的图标会和格子边连成一块
  const fg = m.fg.slice()
  const band = Math.max(3, Math.round(Math.min(W, H) * 0.004))
  for (const r of rects) clearBorder(fg, W, H, r.box, band)
  const comps = components(fg, W, H)
  const minSide = Math.max(3, Math.round(Math.min(W, H) * 0.004))
  const small = comps.filter((c) => c.box.w >= 2 && c.box.h >= 2 && c.n >= minSide * minSide * 0.6)
  // 先把横着挨得很近、一样高的小块并成文字行
  const lines = textLines(small, H)
  const used = new Set(lines.flatMap((l) => l.parts))
  const rest = small.filter((_, i) => !used.has(i))
  // 很稀的大块（外框线、整圈描边）单独成一个装饰，不参与合并：它的外接框会把框里所有东西都吞进去
  const sparse = (c: Comp) => c.n < c.box.w * c.box.h * 0.12 && Math.max(c.box.w, c.box.h) > Math.min(W, H) * 0.15
  // 其余的按距离并成团（一个图标常是好几块）
  const gap = Math.max(3, Math.round(Math.min(W, H) * 0.006))
  // 贴在格子角上的小块（数量、角标）单独成一个元素（只看格子：面板角上的是按钮、图标）：和旁边的图标并在一起，抠图补底时会被一起擦掉
  const badge = (c: Comp) =>
    rects.some(
      (r) =>
        r.kind === 'slot' &&
        c.box.w * c.box.h < r.box.w * r.box.h * 0.04 &&
        hugsCorner(r.box, c.box, Math.max(band + 3, Math.min(r.box.w, r.box.h) * 0.14)),
    )
  const loose = rest.filter((c) => !sparse(c) && !badge(c))
  const groups = [
    ...mergeNear(
      loose.map((c) => c.box),
      gap,
    ),
    ...rest.filter(sparse).map((c) => c.box),
  ]
  const out: Blob[] = []
  // 角标多是一两个数字：比一般的块小，不按最小尺寸筛，直接当文字
  for (const c of rest.filter((c) => !sparse(c) && badge(c)))
    if (c.box.h >= minSide * 2 && !lines.some((l) => inside(c.box, l.box)))
      out.push({ box: c.box, kind: 'text', conf: 0.8, color: boxColor(img, m, c.box).color })
  const minArea = W * H * 0.00008
  for (const l of lines) {
    const { color, spread } = boxColor(img, m, l.box)
    // 单色的才算文字；颜色很杂的是一排小图标
    if (spread > 70) groups.push(l.box)
    else out.push({ box: l.box, kind: 'text', conf: 0.85, color })
  }
  for (const b of groups) {
    if (b.w * b.h < minArea || b.w < minSide * 2 || b.h < minSide * 2) continue
    // 和某个容器几乎一样大的是容器自己的底纹
    if (rects.some((r) => iou(r.box, b) > 0.8)) continue
    // 贴着某个容器内沿一个角的是容器自己的底色（被里面的图标切成了几块），不是元素
    if (rects.some((r) => hugsCorner(r.box, b, band + 3) && sameAsFill(img, m, r.box, b, band + 2))) continue
    const ratio = b.w / b.h
    const kind: ElementKind = ratio > 0.4 && ratio < 2.5 && b.w * b.h < W * H * 0.04 ? 'icon' : 'decoration'
    const contrast = m.strength(b)
    out.push({ box: b, kind, conf: Math.max(0.3, Math.min(0.97, contrast)), color: '' })
  }
  return out
}

function hugsCorner(r: Box, b: Box, d: number) {
  if (b.x < r.x - 1 || b.y < r.y - 1 || b.x + b.w > r.x + r.w + 1 || b.y + b.h > r.y + r.h + 1) return false
  const l = b.x - r.x <= d
  const t = b.y - r.y <= d
  const rt = r.x + r.w - (b.x + b.w) <= d
  const bt = r.y + r.h - (b.y + b.h) <= d
  return (l || rt) && (t || bt)
}

/** 块的颜色和容器内沿一圈的颜色（中位数）几乎一样：是容器的底色。角上的数字、角标颜色不一样，留着 */
function sameAsFill(img: Img, m: Masks, r: Box, b: Box, inset: number) {
  const { width: W, data } = img
  const ring: number[][] = []
  const x0 = Math.round(r.x + inset)
  const y0 = Math.round(r.y + inset)
  const x1 = Math.round(r.x + r.w - inset - 1)
  const y1 = Math.round(r.y + r.h - inset - 1)
  const at = (x: number, y: number) => {
    const o = (y * W + x) * 4
    ring.push([data[o], data[o + 1], data[o + 2]])
  }
  for (let x = x0; x <= x1; x += 2) {
    at(x, y0)
    at(x, y1)
  }
  for (let y = y0; y <= y1; y += 2) {
    at(x0, y)
    at(x1, y)
  }
  if (!ring.length) return false
  const med = [0, 1, 2].map((c) => ring.map((v) => v[c]).sort((p, q) => p - q)[ring.length >> 1])
  // 块里的前景像素有一半以上接近底色就是底色（底色常把里面的图标连成一块）
  let near = 0
  let all = 0
  for (let y = Math.round(b.y); y < Math.round(b.y + b.h); y++)
    for (let x = Math.round(b.x); x < Math.round(b.x + b.w); x++) {
      if (!m.fg[y * W + x]) continue
      const o = (y * W + x) * 4
      all++
      if (Math.max(...med.map((v, i) => Math.abs(data[o + i] - v))) < 24) near++
    }
  return all > 0 && near > all * 0.5
}

function clearBorder(fg: Uint8Array, W: number, H: number, b: Box, band: number) {
  const x0 = Math.round(b.x)
  const y0 = Math.round(b.y)
  const x1 = Math.round(b.x + b.w)
  const y1 = Math.round(b.y + b.h)
  for (let y = Math.max(0, y0 - band); y <= Math.min(H - 1, y1 + band); y++)
    for (let x = Math.max(0, x0 - band); x <= Math.min(W - 1, x1 + band); x++) {
      const inside = x > x0 + band && x < x1 - band && y > y0 + band && y < y1 - band
      if (!inside) fg[y * W + x] = 0
    }
}

interface Comp {
  box: Box
  n: number
}

/** 8 连通的连通块（只要外接框和像素数） */
export function components(mask: Uint8Array, W: number, H: number): Comp[] {
  const seen = new Uint8Array(W * H)
  const out: Comp[] = []
  const stack: number[] = []
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || seen[p]) continue
    let x0 = W
    let y0 = H
    let x1 = 0
    let y1 = 0
    let n = 0
    stack.push(p)
    seen[p] = 1
    while (stack.length) {
      const q = stack.pop()!
      const x = q % W
      const y = (q - x) / W
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const r = ny * W + nx
          if (mask[r] && !seen[r]) {
            seen[r] = 1
            stack.push(r)
          }
        }
    }
    out.push({ box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, n })
  }
  return out
}

/** 文字行：高度相近、上下对齐、左右间距小于字高的小块串起来，至少 2 块、横向比纵向长 */
function textLines(comps: Comp[], H: number) {
  const maxH = H * 0.07
  const idx = comps
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.box.h <= maxH && c.box.h >= 4)
    .sort((a, b) => a.c.box.x - b.c.box.x)
  const lines: { box: Box; parts: number[]; h: number }[] = []
  for (const { c, i } of idx) {
    const cy = c.box.y + c.box.h / 2
    const hit = lines.find((l) => {
      const ly = l.box.y + l.box.h / 2
      const gapX = c.box.x - (l.box.x + l.box.w)
      return (
        Math.abs(cy - ly) < l.h * 0.45 &&
        gapX < l.h * 0.9 &&
        gapX > -l.h * 0.5 &&
        c.box.h < l.h * 1.9 &&
        c.box.h > l.h * 0.25
      )
    })
    if (hit) {
      hit.box = union(hit.box, c.box)
      hit.parts.push(i)
      hit.h = Math.max(hit.h, c.box.h)
    } else lines.push({ box: { ...c.box }, parts: [i], h: c.box.h })
  }
  return lines.filter((l) => l.parts.length >= 2 && l.box.w > l.box.h * 1.1)
}

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
const near = (a: Box, b: Box, d: number) =>
  a.x - d <= b.x + b.w && b.x - d <= a.x + a.w && a.y - d <= b.y + b.h && b.y - d <= a.y + a.h

const area = (b: Box) => b.w * b.h

/** 外接框距离不超过 gap 的反复合并，直到不再变 */
function mergeNear(boxes: Box[], gap: number): Box[] {
  let list = boxes.map((b) => ({ ...b }))
  let changed = true
  while (changed) {
    changed = false
    const next: Box[] = []
    for (const b of list) {
      // 并起来的框比两块加起来大很多的不并：细长的边框线、角花挨着别的东西时，外接框会把中间的按钮整个吞进去
      const hit = next.find((x) => near(x, b, gap) && area(union(x, b)) <= 2.5 * (area(x) + area(b)))
      if (hit) {
        Object.assign(hit, union(hit, b))
        changed = true
      } else next.push(b)
    }
    list = next
  }
  return list
}

// ---- 收尾：吸附、命名、对齐、覆盖率 ----

const roundBox = (b: Box): Box => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  w: Math.max(1, Math.round(b.w)),
  h: Math.max(1, Math.round(b.h)),
})

/** 四条边各自在 ±r 像素里找梯度最大的位置（在原画分辨率上），框贴到真实的边上 */
export function snap(src: Img, b: Box, r = 3): Box {
  const { width: W, height: H, data } = src
  const l = (x: number, y: number) => {
    const o = (Math.max(0, Math.min(H - 1, Math.round(y))) * W + Math.max(0, Math.min(W - 1, Math.round(x)))) * 4
    return (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) * (data[o + 3] / 255)
  }
  // 前向差分：f(p) 是第 p 和 p+1 个像素之间的跳变。描边有两道跳变（外侧、内侧），取最外面那道够强的：
  // 框是元素占的像素范围，描边要算在里面
  const side = (horiz: boolean, pos: number, a: number, b2: number, outward: -1 | 1) => {
    const vals: number[] = []
    const steps = Math.max(4, Math.min(40, Math.round(b2 - a)))
    const base = Math.round(pos)
    for (let d = -r; d <= r; d++) {
      let s = 0
      for (let i = 0; i <= steps; i++) {
        const t = a + ((b2 - a) * i) / steps
        const p = base + d
        s += horiz ? Math.abs(l(t, p) - l(t, p - 1)) : Math.abs(l(p, t) - l(p - 1, t))
      }
      vals.push(s)
    }
    const max = Math.max(...vals)
    if (max <= 0) return pos
    // vals[i] 是第 base+i-r-1 和 base+i-r 之间的跳变：边界落在 base+i-r
    const idx = vals.map((v, i) => (v >= max * 0.6 ? i : -1)).filter((i) => i >= 0)
    const pick = outward < 0 ? idx[0] : idx[idx.length - 1]
    return base + pick - r
  }
  const top = side(true, b.y, b.x + b.w * 0.15, b.x + b.w * 0.85, -1)
  const bottom = side(true, b.y + b.h, b.x + b.w * 0.15, b.x + b.w * 0.85, 1)
  const left = side(false, b.x, b.y + b.h * 0.15, b.y + b.h * 0.85, -1)
  const right = side(false, b.x + b.w, b.y + b.h * 0.15, b.y + b.h * 0.85, 1)
  return roundBox({ x: left, y: top, w: right - left, h: bottom - top })
}

const PREFIX: Record<ElementKind, string> = {
  background: 'Bg',
  panel: 'Panel',
  button: 'Btn',
  slot: 'Slot',
  icon: 'Icon',
  text: 'Txt',
  bar: 'Bar',
  input: 'Input',
  decoration: 'Deco',
  other: 'Widget',
}

/** 还没名字的按类型编号（Panel_1、Icon_3），模型标注时会换成有意思的名字 */
export function nameAll(list: RestoreElement[]) {
  const used = new Set(list.map((e) => e.name).filter(Boolean))
  const count: Partial<Record<ElementKind, number>> = {}
  for (const e of list) {
    if (e.name) continue
    let name = ''
    do name = `${PREFIX[e.kind]}_${(count[e.kind] = (count[e.kind] ?? 0) + 1)}`
    while (used.has(name))
    used.add(name)
    e.name = name
  }
}
export const kindPrefix = (k: ElementKind) => PREFIX[k]

/** 文字在它所在的容器里居中就按居中对齐（按钮上的字、标题），否则左对齐 */
function alignIn(e: RestoreElement, all: RestoreElement[]): 'left' | 'center' | 'right' {
  const parent = all
    .filter((p) => p !== e && p.kind !== 'text' && contains(p.box, e.box))
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0]
  if (!parent) return 'left'
  const cx = e.box.x + e.box.w / 2
  const pcx = parent.box.x + parent.box.w / 2
  if (Math.abs(cx - pcx) < parent.box.w * 0.04 + 2) return 'center'
  const right = parent.box.x + parent.box.w - (e.box.x + e.box.w)
  const left = e.box.x - parent.box.x
  return right < left * 0.5 ? 'right' : 'left'
}

export const contains = (outer: Box, inner: Box, tol = 2) =>
  inner.x >= outer.x - tol &&
  inner.y >= outer.y - tol &&
  inner.x + inner.w <= outer.x + outer.w + tol &&
  inner.y + inner.h <= outer.y + outer.h + tol

function coverageOf(m: Masks, W: number, H: number, list: RestoreElement[], k: number) {
  const covered = new Uint8Array(W * H)
  for (const e of list) {
    if (e.kind === 'background' || e.hidden) continue
    const x0 = Math.max(0, Math.floor(e.box.x * k))
    const y0 = Math.max(0, Math.floor(e.box.y * k))
    const x1 = Math.min(W - 1, Math.ceil((e.box.x + e.box.w) * k))
    const y1 = Math.min(H - 1, Math.ceil((e.box.y + e.box.h) * k))
    for (let y = y0; y <= y1; y++) covered.fill(1, y * W + x0, y * W + x1 + 1)
  }
  let fg = 0
  let hit = 0
  const left = new Uint8Array(W * H)
  for (let p = 0; p < W * H; p++)
    if (m.fg[p]) {
      fg++
      if (covered[p]) hit++
      else left[p] = 1
    }
  // 没框住、又成片的（面积超过图的 0.3%）提醒用户
  const uncovered = components(left, W, H)
    .filter((c) => c.n > W * H * 0.003)
    .map((c) => roundBox({ x: c.box.x / k, y: c.box.y / k, w: c.box.w / k, h: c.box.h / k }))
    .slice(0, 6)
  return { coverage: fg ? hit / fg : 1, uncovered }
}
