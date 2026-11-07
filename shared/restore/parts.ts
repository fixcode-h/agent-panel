import { chromaKey, crop, hasAlpha, removeFlatBackground, resize, type Img } from '../raster.ts'
import type { DesignKind } from '../design.ts'
import { fillHoles, holesOf } from './assets.ts'
import { parentsOf } from './compile.ts'
import { similarity } from './similarity.ts'
import { CONTAINER_KINDS, type Box, type RestoreElement } from './schema.ts'

/**
 * 拆件图：让图片模型照着原画，把界面里的每个元素（底框、按钮、格子、图标、装饰）单独画一遍，
 * 摆在透明底上互不重叠（模型给不了透明时退回纯绿底，切的时候去色键）。直接从原画抠，框里会夹着别的 UI（面板里的图标、按钮上的字、格子后面的光），
 * 拆件图里每件都是干净的、本来就透明的，切图从这里切。
 * 位置仍以原画为准（算法量的元素框），拆件图只提供像素：切开后按形状、颜色和原画里的元素一一对上，
 * 对不上的退回从原画抠
 */

export interface Part {
  /** 在拆件图里的框 */
  box: Box
  /** 抠成透明底的这一件 */
  img: Img
}

export interface PartMatch {
  part: number
  /** 缩放到元素在原画里的大小 */
  img: Img
  score: number
}

/** 对上的门槛：低于它的不用拆件图，退回从原画抠 */
export const PART_MIN_SCORE = 0.6

/** 交给模型的元素清单：重复的同类（格子、同样的按钮）只列一次 */
function partList(elements: RestoreElement[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of elements) {
    if (e.hidden || e.kind === 'background' || e.kind === 'text') continue
    const key = `${e.kind}:${Math.round(e.box.w / 8)}x${Math.round(e.box.h / 8)}`
    if (e.kind !== 'icon' && seen.has(key)) continue
    seen.add(key)
    out.push(`- ${e.name || e.kind} (${e.kind}, about ${Math.round(e.box.w)}×${Math.round(e.box.h)} px in the screen)`)
  }
  return out.slice(0, 60)
}

/** 出拆件图的提示词（英文：图片模型对英文的约束跟得更紧） */
export function partsPrompt(
  kind: DesignKind | undefined,
  elements: RestoreElement[],
  art: { width: number; height: number },
) {
  const list = partList(elements)
  return [
    `The attached image is a finished ${kind === 'web' ? 'web page' : 'game UI screen'} (${art.width}×${art.height}). Redraw it as a UI parts sheet for slicing: every distinct visual element of the screen drawn separately, so each one can be cut out cleanly.`,
    'Draw each element exactly as it looks in the screen: same art style, shape, proportions, colors, materials, borders, glow and level of detail, at the same relative size. Containers (window frames, panels, cards, buttons, slots / cells, progress bars, input boxes) are drawn EMPTY: no icons, text, numbers or other elements inside them, only their own frame and fill. Icons and ornaments are drawn on their own without the frame or slot behind them. Repeated identical elements (the same empty slot, the same button) are drawn only once.',
    'Output a PNG with a TRANSPARENT background (alpha channel): only the empty space between parts is fully transparent, no backdrop color, no scene. Each part keeps its own fill and background colors exactly as in the screen (an opaque panel stays opaque with its own fill; only what is transparent around an icon or ornament in the screen is transparent). Only if transparency is impossible, use one pure solid #00FF00 green background instead. Keep clear gaps of at least 24 px between parts; parts never overlap, never touch and nothing connects them. No text, labels, numbers, grid lines, cell frames or drop shadows between the parts. Do not draw the full-screen background scene.',
    list.length ? `Elements to include:\n${list.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 把拆件图按连通的块切开：本来就是透明底的直接切；模型给的不透明（退回了绿底）就先去色键，不是绿底再去平底。
 * 挨得很近的碎块（光晕、描边断开的地方）并成一件
 */
export function splitParts(sheet: Img): Part[] {
  let keyed = sheet
  if (!hasAlpha(keyed)) keyed = chromaKey(sheet)
  if (!hasAlpha(keyed)) keyed = removeFlatBackground(sheet)
  const { width: W, height: H, data } = keyed
  const solid = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) solid[i] = data[i * 4 + 3] > 40 ? 1 : 0
  // 外扩 3 像素再找连通块：断开一两个像素的同一件不拆成两件
  const R = 3
  const rows = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    let run = -1e9
    for (let x = 0; x < W; x++) {
      if (solid[y * W + x]) run = x
      if (x - run <= R) rows[y * W + x] = 1
    }
    run = 1e9
    for (let x = W - 1; x >= 0; x--) {
      if (solid[y * W + x]) run = x
      if (run - x <= R) rows[y * W + x] = 1
    }
  }
  const grown = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) {
    let run = -1e9
    for (let y = 0; y < H; y++) {
      if (rows[y * W + x]) run = y
      if (y - run <= R) grown[y * W + x] = 1
    }
    run = 1e9
    for (let y = H - 1; y >= 0; y--) {
      if (rows[y * W + x]) run = y
      if (run - y <= R) grown[y * W + x] = 1
    }
  }
  const label = new Int32Array(W * H)
  const parts: Part[] = []
  const minArea = Math.max(36, W * H * 0.0002)
  let next = 0
  const stack: number[] = []
  for (let s = 0; s < W * H; s++) {
    if (!grown[s] || label[s]) continue
    next++
    label[s] = next
    stack.push(s)
    // 框只按真正不透明的像素算（外扩出来的那圈不算）
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    let area = 0
    while (stack.length) {
      const p = stack.pop()!
      const x = p % W
      const y = (p - x) / W
      if (solid[p]) {
        area++
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || label[q] || !grown[q]) continue
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue
        label[q] = next
        stack.push(q)
      }
    }
    if (area < minArea || x1 - x0 < 5 || y1 - y0 < 5) continue
    const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    // 只留这一件自己的像素：框里别的块（另一件伸进来的角）抠掉
    const img = crop(keyed, box.x, box.y, box.w, box.h)
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++)
        if (label[(box.y + y) * W + box.x + x] !== next) img.data[(y * box.w + x) * 4 + 3] = 0
    parts.push({ box, img })
  }
  return parts
}

/** 长边缩到 side，比较用 */
const small = (img: Img, side = 48) => {
  const k = side / Math.max(img.width, img.height)
  return k >= 1 ? img : resize(img, Math.max(4, Math.round(img.width * k)), Math.max(4, Math.round(img.height * k)))
}

/**
 * 一件和原画里那一块有多像：
 * - 一致率：这件不透明的像素里，和原画同一位置颜色差不到 40 的占多少（容器里装着的东西会拉低，但对的那件仍最高）；
 * - 结构：把这件贴到原画那一块上（透明的地方露出原画），整块和原画比相似度。
 * 几乎全透明的件贴上去什么都没改，结构分虚高，所以不透明的要占一成以上
 */
export function partScore(part: Img, art: Img) {
  const p = resize(part, art.width, art.height)
  let solid = 0
  let agree = 0
  const comp = { width: art.width, height: art.height, data: art.data.slice() }
  for (let i = 0; i < p.data.length; i += 4) {
    const a = p.data[i + 3]
    if (a > 128) {
      solid++
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(p.data[i + c] - art.data[i + c]))) < 40) agree++
    }
    const k = a / 255
    for (let c = 0; c < 3; c++) comp.data[i + c] = Math.round(p.data[i + c] * k + art.data[i + c] * (1 - k))
  }
  const cover = solid / (p.width * p.height)
  if (cover < 0.1) return 0
  return 0.6 * (agree / solid) + 0.4 * similarity(comp, art, 48)
}

/**
 * 原画里的每个元素（文字、背景不切）找最像的一件：宽高比差太多的不比；
 * 同一件可以给好几个元素用（重复的格子只画了一次）。返回元素 id → 缩放到元素大小的那件
 */
export function matchParts(art: Img, elements: RestoreElement[], parts: Part[], min = PART_MIN_SCORE) {
  const out = new Map<string, PartMatch>()
  const thumbs = parts.map((p) => small(p.img))
  const live = elements.filter((e) => !e.hidden)
  const parents = parentsOf(live)
  for (const e of live) {
    if (e.kind === 'background' || e.kind === 'text') continue
    const b = {
      x: Math.round(e.box.x),
      y: Math.round(e.box.y),
      w: Math.max(1, Math.round(e.box.w)),
      h: Math.max(1, Math.round(e.box.h)),
    }
    // 容器拿「挖掉子元素、补成自己底色」的样子去比：拆件图里的容器是空的，
    // 直接拿原画那块比，会选中把子元素一起画进去的那件
    const holes = CONTAINER_KINDS.includes(e.kind) ? holesOf(e, live, parents) : []
    const raw = crop(art, b.x, b.y, b.w, b.h)
    const target = small(holes.length ? fillHoles(raw, holes) : raw)
    const ar = b.w / b.h
    let best: { part: number; score: number } | undefined
    parts.forEach((p, i) => {
      if (Math.abs(Math.log(ar / (p.box.w / p.box.h))) > 0.3) return
      const score = partScore(thumbs[i], target)
      if (score >= min && (!best || score > best.score)) best = { part: i, score }
    })
    if (best) out.set(e.id, { ...best, img: resize(parts[best.part].img, b.w, b.h) })
  }
  return out
}

/** 拆件图里本该有、却没对上的元素（容器、图标、装饰都算），卡上列出来 */
export const unmatched = (elements: RestoreElement[], matched: Map<string, PartMatch>) =>
  elements.filter(
    (e) =>
      !e.hidden &&
      e.kind !== 'background' &&
      e.kind !== 'text' &&
      !matched.has(e.id) &&
      (CONTAINER_KINDS.includes(e.kind) || e.kind === 'icon' || e.kind === 'decoration'),
  )
