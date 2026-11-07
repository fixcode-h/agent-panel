import type { Img } from '../raster.ts'

/**
 * 网页还原的「能用 CSS 画的不切图」：底框是纯色、可能带一圈描边和圆角的（按钮、卡片、输入框），
 * 量出底色、描边、圆角写成样式；有渐变、纹理、阴影的（中间一片不平）返回 undefined，照常用切图
 */
export interface FlatStyle {
  bg: string
  radius: number
  borderWidth: number
  borderColor: string
}

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()
export const hexOf = (c: number[]) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}FF`
const dist = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

function median(list: number[][]) {
  return [0, 1, 2].map((c) => {
    const v = list.map((p) => p[c]).sort((a, b) => a - b)
    return v[v.length >> 1] ?? 0
  })
}

export function flatStyle(img: Img): FlatStyle | undefined {
  const { width: W, height: H, data } = img
  if (W < 8 || H < 8) return undefined
  const at = (x: number, y: number) => {
    const o = (y * W + x) * 4
    return [data[o], data[o + 1], data[o + 2], data[o + 3]]
  }
  // 中间八成：九成七以上的像素和中位色差不到 10 才算纯色
  const inner: number[][] = []
  for (let y = Math.floor(H * 0.2); y < Math.ceil(H * 0.8); y++)
    for (let x = Math.floor(W * 0.2); x < Math.ceil(W * 0.8); x++) inner.push(at(x, y))
  const fill = median(inner)
  if (inner.filter((p) => p[3] > 200 && dist(p, fill) <= 10).length < inner.length * 0.97) return undefined

  // 描边：从左右上下边的中点往里走，和底色差得多的那几层
  const probes = [
    (i: number) => at(i, H >> 1),
    (i: number) => at(W - 1 - i, H >> 1),
    (i: number) => at(W >> 1, i),
    (i: number) => at(W >> 1, H - 1 - i),
  ]
  const edge = median(probes.map((p) => p(0)))
  let bw = 0
  if (dist(edge, fill) > 20) {
    const max = Math.min(6, Math.floor(Math.min(W, H) / 4))
    while (bw < max && probes.every((p) => dist(p(bw), edge) <= 24)) bw++
    if (!bw) return undefined
  }
  const own = (p: number[]) => p[3] > 128 && (dist(p, fill) <= 16 || (bw > 0 && dist(p, edge) <= 24))
  // 圆角：从四个角沿对角线走，不属于这个框的像素有几个（圆角半径 ≈ 对角线上缺的长度 × 3.41）
  const corner = (cx: number, cy: number, sx: number, sy: number) => {
    let d = 0
    while (d < Math.min(W, H) / 2 && !own(at(cx + sx * d, cy + sy * d))) d++
    return d
  }
  const ds = [corner(0, 0, 1, 1), corner(W - 1, 0, -1, 1), corner(0, H - 1, 1, -1), corner(W - 1, H - 1, -1, -1)]
  const radius = Math.round(median(ds.map((d) => [d, d, d]))[0] * 3.41)
  return {
    bg: hexOf(fill),
    radius: Math.min(radius, Math.floor(Math.min(W, H) / 2)),
    borderWidth: bw,
    borderColor: bw ? hexOf(edge) : '#00000000',
  }
}

/** 颜色聚成几档（差 12 以内算一档），返回每档的代表色和用到它的次数，多的在前 */
export function clusterColors(colors: string[]) {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const out: { color: number[]; n: number }[] = []
  for (const c of colors) {
    if (!/^#[0-9A-F]{6}/i.test(c)) continue
    const v = rgb(c)
    const hit = out.find((o) => dist(o.color, v) <= 12)
    if (hit) hit.n++
    else out.push({ color: v, n: 1 })
  }
  return out.sort((a, b) => b.n - a.n).map((o) => ({ color: hexOf(o.color), n: o.n }))
}

/** 字号聚成几档（差 1px 以内算一档） */
export function clusterSizes(sizes: number[]) {
  const out: { size: number; n: number }[] = []
  for (const s of [...sizes].sort((a, b) => a - b)) {
    const hit = out.find((o) => Math.abs(o.size - s) <= 1)
    if (hit) hit.n++
    else out.push({ size: s, n: 1 })
  }
  return out
}
