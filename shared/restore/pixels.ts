import type { Img } from '../raster.ts'
import type { Box } from './schema.ts'

/** 检测用的几张图：前景、强边缘，以及量一块区域「有多突出」 */
export interface Masks {
  /** 和局部背景差得多的像素 */
  fg: Uint8Array
  /** 梯度大的像素（找直线用） */
  edge: Uint8Array
  /** 一块区域里前景和背景差多少（0~1，给把握打分） */
  strength: (b: Box) => number
  diff: Float32Array
  /** 前景的门槛 */
  td: number
}

/** 按宽度分开的盒式模糊（横竖各一遍，滑动求和，O(像素数)） */
function boxBlur(src: Float32Array, W: number, H: number, r: number) {
  const tmp = new Float32Array(W * H)
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    let s = 0
    let n = 0
    for (let x = -r; x < W; x++) {
      const add = x + r
      if (add < W) {
        s += src[y * W + add]
        n++
      }
      if (x - r - 1 >= 0) {
        s -= src[y * W + x - r - 1]
        n--
      }
      if (x >= 0) tmp[y * W + x] = s / n
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0
    let n = 0
    for (let y = -r; y < H; y++) {
      const add = y + r
      if (add < H) {
        s += tmp[add * W + x]
        n++
      }
      if (y - r - 1 >= 0) {
        s -= tmp[(y - r - 1) * W + x]
        n--
      }
      if (y >= 0) out[y * W + x] = s / n
    }
  }
  return out
}

/** Otsu 阈值（0~255 的直方图） */
export function otsu(v: Float32Array) {
  const hist = new Float64Array(256)
  for (let i = 0; i < v.length; i++) hist[Math.max(0, Math.min(255, Math.round(v[i])))]++
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let at = 0
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = v.length - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) {
      best = between
      at = t
    }
  }
  return at
}

export function foreground(img: Img): Masks {
  const { width: W, height: H, data } = img
  const ch = [0, 1, 2].map(() => new Float32Array(W * H))
  const luma = new Float32Array(W * H)
  for (let p = 0; p < W * H; p++) {
    // 透明的地方当黑底（PSD 合成图、抠过的图）
    const a = data[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) ch[c][p] = data[p * 4 + c] * a
    luma[p] = 0.299 * ch[0][p] + 0.587 * ch[1][p] + 0.114 * ch[2][p]
  }
  // 局部背景：半径是短边的 3%，比按钮、图标大，比整块面板小
  const r = Math.max(4, Math.round(Math.min(W, H) * 0.03))
  const blur = ch.map((c) => boxBlur(c, W, H, r))
  const diff = new Float32Array(W * H)
  for (let p = 0; p < W * H; p++)
    diff[p] = Math.max(
      Math.abs(ch[0][p] - blur[0][p]),
      Math.abs(ch[1][p] - blur[1][p]),
      Math.abs(ch[2][p] - blur[2][p]),
    )
  const grad = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x
      grad[p] = Math.min(255, Math.abs(luma[p + 1] - luma[p - 1]) + Math.abs(luma[p + W] - luma[p - W]))
    }
  // 门槛不能直接用 Otsu：它会落在「高对比的东西」和「其余」之间，暗底上的暗紫色格子边、
  // 半透明面板的描边全被当成背景。取它的一半，夹在一个范围里（星空这类孤立的噪点靠后面的长度、面积过滤）
  const td = Math.max(14, Math.min(48, otsu(diff) * 0.5))
  const te = Math.max(12, Math.min(40, otsu(grad) * 0.4))
  const fg = new Uint8Array(W * H)
  const edge = new Uint8Array(W * H)
  for (let p = 0; p < W * H; p++) {
    if (diff[p] > td) fg[p] = 1
    if (grad[p] > te) edge[p] = 1
  }
  const strength = (b: Box) => {
    let s = 0
    let n = 0
    for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(H, Math.ceil(b.y + b.h)); y++)
      for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(W, Math.ceil(b.x + b.w)); x++) {
        const p = y * W + x
        if (fg[p]) {
          s += diff[p]
          n++
        }
      }
    return n ? Math.min(1, s / n / (td * 2.2)) : 0
  }
  return { fg, edge, strength, diff, td }
}

/** 按需算原画上某一点的梯度（框边吸附只看几条线，不用整张图算一遍） */
export function gradient(img: Img) {
  const { width: W, height: H, data } = img
  const l = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(W - 1, x))
    const cy = Math.max(0, Math.min(H - 1, y))
    const o = (cy * W + cx) * 4
    const a = data[o + 3] / 255
    return (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) * a
  }
  return { at: (x: number, y: number) => Math.abs(l(x + 1, y) - l(x - 1, y)) + Math.abs(l(x, y + 1) - l(x, y - 1)) }
}

const hex = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()

/** 一块区域里前景像素的平均色（文字颜色）和颜色的离散程度（单色的才像文字） */
export function boxColor(img: Img, m: Masks, b: Box) {
  const { width: W, data } = img
  const px: number[][] = []
  for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(img.height, Math.ceil(b.y + b.h)); y++)
    for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(W, Math.ceil(b.x + b.w)); x++) {
      const p = y * W + x
      // 只取最「实」的那些：抗锯齿的边是混色，会把颜色拉偏
      if (m.diff[p] > m.td * 1.6) px.push([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]])
    }
  if (!px.length) return { color: '#FFFFFFFF', spread: 0 }
  const mean = [0, 1, 2].map((c) => px.reduce((s, v) => s + v[c], 0) / px.length)
  const spread =
    px.reduce((s, v) => s + Math.abs(v[0] - mean[0]) + Math.abs(v[1] - mean[1]) + Math.abs(v[2] - mean[2]), 0) /
    px.length
  return { color: `#${hex(mean[0])}${hex(mean[1])}${hex(mean[2])}FF`, spread }
}
