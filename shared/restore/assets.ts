import { blank, crop, hasAlpha, paste, removeFlatBackground, resize, type Img } from '../raster.ts'
import { similarity } from './similarity.ts'
import { CONTAINER_KINDS, type Box, type RestoreElement } from './schema.ts'
import { parentsOf } from './compile.ts'

/**
 * 切图：每个元素从原画里抠，不重画（重画永远和原画不一样）。
 * - 容器（面板、格子、按钮、背景）：把它装着的元素那几块补成周围的颜色，留下干净的底（文字擦掉，图标拿走）；
 *   中间一片平的再标九宫格边距，拉伸时边框不变形
 * - 图标、装饰：去掉平底，能透明就透明
 * - 文字不切图（编成文字控件）
 * 大小一样、长得一样的（重复组里的空格子）合成一张图共用。
 * 最后把所有切图按位置贴回去拼成一张（文字用原画那一块代替），和原画逐块比相似度：拼出来像原画，才说明切图对
 */

export interface Slice {
  element: string
  img: Img
  transparent: boolean
  /** 九宫格边距（比例 0~1） */
  nineSlice?: { Left: number; Top: number; Right: number; Bottom: number }
  /** 和另一个元素长得一样：直接用它的图 */
  same?: string
}

export interface ExtractResult {
  slices: Slice[]
  /** 元素 id → 拼回去以后那一块和原画的相似度 */
  sims: Record<string, number>
  /** 擦掉所有元素的干净背景（原画尺寸） */
  plate: Img
}

const rnd = (b: Box): Box => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  w: Math.max(1, Math.round(b.w)),
  h: Math.max(1, Math.round(b.h)),
})

/**
 * 把图里几块区域补掉：每个像素取它所在行、列上紧挨区域外面的四个像素，按距离加权平均。
 * 对平的、渐变的底效果很好；有花纹的底会糊一点（花纹底以后交给 ComfyUI 的重绘）
 */
export function fillHoles(img: Img, holes: Box[]): Img {
  const out = { width: img.width, height: img.height, data: img.data.slice() }
  const W = img.width
  const H = img.height
  const mask = new Uint8Array(W * H)
  // 洞往外扩几像素（短边的 0.7%，至少 3）：框贴着的是元素自己的描边、外发光，从描边上取色会把整片补成描边的颜色
  const pad = Math.max(3, Math.round(Math.min(W, H) * 0.007))
  for (const b of holes.map(rnd))
    for (let y = Math.max(0, b.y - pad); y < Math.min(H, b.y + b.h + pad); y++)
      for (let x = Math.max(0, b.x - pad); x < Math.min(W, b.x + b.w + pad); x++) mask[y * W + x] = 1
  // 每个洞里的像素往四个方向最近的「洞外」像素：按行、按列各扫两遍记下来，O(像素数)
  const left = new Int32Array(W * H).fill(-1)
  const right = new Int32Array(W * H).fill(-1)
  const up = new Int32Array(W * H).fill(-1)
  const down = new Int32Array(W * H).fill(-1)
  for (let y = 0; y < H; y++) {
    let last = -1
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (mask[p]) left[p] = last
      else last = x
    }
    last = -1
    for (let x = W - 1; x >= 0; x--) {
      const p = y * W + x
      if (mask[p]) right[p] = last
      else last = x
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -1
    for (let y = 0; y < H; y++) {
      const p = y * W + x
      if (mask[p]) up[p] = last
      else last = y
    }
    last = -1
    for (let y = H - 1; y >= 0; y--) {
      const p = y * W + x
      if (mask[p]) down[p] = last
      else last = y
    }
  }
  const acc = [0, 0, 0, 0]
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (!mask[p]) continue
      acc.fill(0)
      let sum = 0
      const take = (q: number, d: number) => {
        const w = 1 / d
        sum += w
        for (let c = 0; c < 4; c++) acc[c] += img.data[q * 4 + c] * w
      }
      if (left[p] >= 0) take(y * W + left[p], x - left[p])
      if (right[p] >= 0) take(y * W + right[p], right[p] - x)
      if (up[p] >= 0) take(up[p] * W + x, y - up[p])
      if (down[p] >= 0) take(down[p] * W + x, down[p] - y)
      if (sum) for (let c = 0; c < 4; c++) out.data[p * 4 + c] = Math.round(acc[c] / sum)
    }
  return out
}

/** 九宫格：从四条边往里走，颜色和中心一样了就是边框的厚度；中间那片要够平才算 */
export function detectNineSlice(img: Img): Slice['nineSlice'] {
  const { width: W, height: H } = img
  if (Math.min(W, H) < 40) return undefined
  const px = (x: number, y: number) => {
    const o = (y * W + x) * 4
    return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]
  }
  const cx = Math.floor(W / 2)
  const cy = Math.floor(H / 2)
  const center = px(cx, cy)
  const close = (p: number[]) =>
    Math.abs(p[0] - center[0]) + Math.abs(p[1] - center[1]) + Math.abs(p[2] - center[2]) + Math.abs(p[3] - center[3]) <
    24
  const walk = (n: number, at: (i: number) => number[]) => {
    for (let i = 0; i < n / 2 - 1; i++) if (close(at(i)) && close(at(i + 1)) && close(at(i + 2))) return i
    return -1
  }
  const L = walk(W, (i) => px(i, cy))
  const R = walk(W, (i) => px(W - 1 - i, cy))
  const T = walk(H, (i) => px(cx, i))
  const B = walk(H, (i) => px(cx, H - 1 - i))
  if (L < 1 || R < 1 || T < 1 || B < 1) return undefined
  // 中间那片：抽样看是不是一样的颜色（有渐变、花纹的不能拉）
  let bad = 0
  let n = 0
  for (let y = T + 2; y < H - B - 2; y += 3)
    for (let x = L + 2; x < W - R - 2; x += 3) {
      n++
      if (!close(px(x, y))) bad++
    }
  if (!n || bad / n > 0.03) return undefined
  const r = (v: number, s: number) => Math.round((Math.min(v + 2, s / 2 - 1) / s) * 1000) / 1000
  return { Left: r(L, W), Top: r(T, H), Right: r(R, W), Bottom: r(B, H) }
}

/** 64 位差分哈希（9×8 灰度相邻比较）：找长得一样的切图 */
function dHash(img: Img) {
  const s = resize(img, 9, 8)
  const bits: number[] = []
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const l = (i: number) => s.data[i] * 0.299 + s.data[i + 1] * 0.587 + s.data[i + 2] * 0.114
      bits.push(l((y * 9 + x) * 4) > l((y * 9 + x + 1) * 4) ? 1 : 0)
    }
  return bits
}
/** 两张图里明显不一样的像素占多少（格子里没框到的小数字：整体很像，但这几个像素不能丢） */
function changed(a: Img, b: Img) {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  let n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * a.width + x) * 4
      const q = (y * b.width + x) * 4
      if (
        Math.max(
          Math.abs(a.data[p] - b.data[q]),
          Math.abs(a.data[p + 1] - b.data[q + 1]),
          Math.abs(a.data[p + 2] - b.data[q + 2]),
        ) > 48
      )
        n++
    }
  return n / Math.max(1, w * h)
}
function clearRatio(img: Img) {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 0) n++
  return n / Math.max(1, img.width * img.height)
}
const hamming = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v === b[i] ? 0 : 1), 0)

/** given：已经有像素的元素（PSD 图层），直接用，不从原画里抠 */
export function extractAssets(art: Img, elements: RestoreElement[], given?: Map<string, Img>): ExtractResult {
  const live = elements.filter((e) => !e.hidden)
  const parents = parentsOf(live)
  const bg = live.find((e) => e.kind === 'background')
  const kidsOf = (id: string | undefined) =>
    live.filter(
      (e) => e.kind !== 'background' && (id === bg?.id ? parents.get(e.id) === undefined : parents.get(e.id) === id),
    )
  const descends = (id: string, root: string) => {
    for (let p = parents.get(id); p; p = parents.get(p)) if (p === root) return true
    return false
  }
  const slices: Slice[] = []
  for (const e of live) {
    if (e.kind === 'text') continue
    const own = given?.get(e.id)
    if (own) {
      slices.push({ element: e.id, img: own, transparent: hasAlpha(own) })
      continue
    }
    const b = rnd(e.box)
    const raw = crop(art, b.x, b.y, b.w, b.h)
    if (e.kind === 'background' || CONTAINER_KINDS.includes(e.kind)) {
      // 子容器几乎铺满了它（详情面板 = 内容区 + 按钮栏）：挖掉子容器就没有能取色的地方了，
      // 改成只挖所有后代里的图标、文字，保留子容器的框
      let kids = kidsOf(e.id)
      const covered = kids.reduce((s, k) => s + (CONTAINER_KINDS.includes(k.kind) ? k.box.w * k.box.h : 0), 0)
      if (e.kind !== 'background' && covered > e.box.w * e.box.h * 0.85)
        kids = live.filter((k) => !CONTAINER_KINDS.includes(k.kind) && k.kind !== 'background' && descends(k.id, e.id))
      const holes = kids.map((k) => ({ x: k.box.x - b.x, y: k.box.y - b.y, w: k.box.w, h: k.box.h }))
      const img = holes.length ? fillHoles(raw, holes) : raw
      slices.push({
        element: e.id,
        img,
        transparent: false,
        nineSlice: e.kind === 'background' ? undefined : detectNineSlice(img),
      })
    } else {
      // 整块几乎都被当成底色抠掉的，本身就是一块纯色（框得很紧的色块图标）：原样留着
      const cut = removeFlatBackground(raw)
      const img = clearRatio(cut) > 0.9 ? raw : cut
      slices.push({ element: e.id, img, transparent: hasAlpha(img) })
    }
  }
  // 抠成透明的地方会露出父容器补过底的那张图：露出来的和原画差得多（格子里的光晕被补成了平的底色），
  // 就不抠了，整块原样留着，保证拼回去和原画一样
  const sliceOf = new Map(slices.map((x) => [x.element, x]))
  const boxOf = new Map(live.map((e) => [e.id, rnd(e.box)]))
  for (const sl of slices) {
    if (!sl.transparent || given?.has(sl.element)) continue
    const pid = parents.get(sl.element) ?? bg?.id
    const parent = pid && sliceOf.get(pid)
    const pb = pid && boxOf.get(pid)
    const b = boxOf.get(sl.element)!
    if (!parent || !pb) continue
    let diff = 0
    let n = 0
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const o = (y * sl.img.width + x) * 4
        if (sl.img.data[o + 3] === 255) continue
        const px = b.x - pb.x + x
        const py = b.y - pb.y + y
        if (px < 0 || py < 0 || px >= parent.img.width || py >= parent.img.height) continue
        const q = (py * parent.img.width + px) * 4
        const a = (b.y + y) * art.width + b.x + x
        diff += Math.max(...[0, 1, 2].map((c) => Math.abs(parent.img.data[q + c] - art.data[a * 4 + c])))
        n++
      }
    if (n && diff / n > 10) {
      sl.img = crop(art, b.x, b.y, b.w, b.h)
      sl.transparent = false
    }
  }
  // 长得一样的共用一张：同样大小（差 2 像素以内）、同类、哈希几乎一样，再用相似度确认
  const hashes = new Map(slices.map((s) => [s.element, dHash(s.img)]))
  const kindOf = new Map(live.map((e) => [e.id, e.kind]))
  for (let i = 0; i < slices.length; i++) {
    const a = slices[i]
    if (a.same || kindOf.get(a.element) === 'background') continue
    for (let j = i + 1; j < slices.length; j++) {
      const b = slices[j]
      if (b.same || kindOf.get(b.element) !== kindOf.get(a.element)) continue
      if (Math.abs(a.img.width - b.img.width) > 2 || Math.abs(a.img.height - b.img.height) > 2) continue
      if (hamming(hashes.get(a.element)!, hashes.get(b.element)!) > 4) continue
      if (similarity(a.img, b.img) < 0.97 || changed(a.img, b.img) > 0.002) continue
      b.same = a.element
    }
  }
  // 拼回去：底图 → 按从大到小贴容器和图标 → 文字贴原画那一块（文字由控件画，这里当它画得一模一样）
  const byId = new Map(slices.map((s) => [s.element, s]))
  const plateSlice = bg && byId.get(bg.id)
  const plate = plateSlice ? plateSlice.img : blank(art.width, art.height, [0, 0, 0, 255])
  const comp = { width: plate.width, height: plate.height, data: plate.data.slice() }
  const order = live.filter((e) => e.kind !== 'background').sort((p, q) => q.box.w * q.box.h - p.box.w * p.box.h)
  for (const e of order) {
    const b = rnd(e.box)
    if (e.kind === 'text') {
      paste(comp, crop(art, b.x, b.y, b.w, b.h), b.x, b.y)
      continue
    }
    const s = byId.get(e.id)
    const src = s?.same ? byId.get(s.same) : s
    if (src)
      paste(comp, src.img.width === b.w && src.img.height === b.h ? src.img : resize(src.img, b.w, b.h), b.x, b.y)
  }
  const sims: Record<string, number> = {}
  for (const e of live) {
    if (e.kind === 'background' || e.kind === 'text') continue
    const b = rnd(e.box)
    sims[e.id] = Math.round(similarity(crop(comp, b.x, b.y, b.w, b.h), crop(art, b.x, b.y, b.w, b.h)) * 1000) / 1000
  }
  return { slices, sims, plate }
}
