/**
 * 不依赖 Node 的像素操作（RGBA 数组）：服务端（server/image.ts 重新导出）、浏览器里的演示版和
 * 原画还原的检测、抠图算法共用。PNG 的编解码要用 zlib，留在 server/image.ts
 */

export interface Img {
  width: number
  height: number
  /** RGBA，每像素 4 字节 */
  data: Uint8Array
}

export const blank = (width: number, height: number, rgba: [number, number, number, number] = [0, 0, 0, 0]): Img => {
  const data = new Uint8Array(width * height * 4)
  if (rgba.some((v) => v)) for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

/** 一个方向上的缩放权重：缩小时取覆盖的像素按面积平均，放大时线性插值 */
function weights(from: number, to: number) {
  const out: { start: number; w: number[] }[] = []
  const ratio = from / to
  for (let i = 0; i < to; i++) {
    if (ratio > 1) {
      const a = i * ratio
      const b = (i + 1) * ratio
      const start = Math.floor(a)
      const w: number[] = []
      for (let j = start; j < Math.min(from, Math.ceil(b)); j++) w.push(Math.min(b, j + 1) - Math.max(a, j))
      out.push({ start, w })
    } else {
      const c = (i + 0.5) * ratio - 0.5
      const j = Math.max(0, Math.min(from - 1, Math.floor(c)))
      const t = Math.min(1, Math.max(0, c - j))
      out.push(j + 1 < from && t > 0 ? { start: j, w: [1 - t, t] } : { start: j, w: [1] })
    }
  }
  return out
}

/** 缩放到精确的宽高（按透明度加权平均，边缘不会发黑） */
export function resize(img: Img, width: number, height: number): Img {
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  if (img.width === width && img.height === height) return img
  const wx = weights(img.width, width)
  const wy = weights(img.height, height)
  // 先横向再纵向；中间结果用预乘的浮点数
  const mid = new Float32Array(width * img.height * 4)
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let sum = 0
      const { start, w } = wx[x]
      for (let k = 0; k < w.length; k++) {
        const o = (y * img.width + start + k) * 4
        const al = img.data[o + 3] * w[k]
        r += img.data[o] * al
        g += img.data[o + 1] * al
        b += img.data[o + 2] * al
        a += al
        sum += w[k]
      }
      // 权重之和不一定是 1（缩小时是覆盖的像素数）：除掉，颜色和透明度保持同一个尺度
      const m = (y * width + x) * 4
      mid[m] = r / sum
      mid[m + 1] = g / sum
      mid[m + 2] = b / sum
      mid[m + 3] = a / sum
    }
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let sum = 0
      const { start, w } = wy[y]
      for (let k = 0; k < w.length; k++) {
        const m = ((start + k) * width + x) * 4
        r += mid[m] * w[k]
        g += mid[m + 1] * w[k]
        b += mid[m + 2] * w[k]
        a += mid[m + 3] * w[k]
        sum += w[k]
      }
      const o = (y * width + x) * 4
      // a 是 alpha×权重之和；预乘的颜色除以它还原
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / sum)
      }
    }
  return { width, height, data: out }
}

export function crop(img: Img, x: number, y: number, w: number, h: number): Img {
  x = Math.max(0, Math.min(img.width - 1, Math.round(x)))
  y = Math.max(0, Math.min(img.height - 1, Math.round(y)))
  w = Math.max(1, Math.min(img.width - x, Math.round(w)))
  h = Math.max(1, Math.min(img.height - y, Math.round(h)))
  const out = new Uint8Array(w * h * 4)
  for (let j = 0; j < h; j++)
    out.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4)
  return { width: w, height: h, data: out }
}

/** 把 src 贴到 dst 的 (x, y) 处（按透明度混合） */
export function paste(dst: Img, src: Img, x: number, y: number) {
  for (let j = 0; j < src.height; j++) {
    const dy = y + j
    if (dy < 0 || dy >= dst.height) continue
    for (let i = 0; i < src.width; i++) {
      const dx = x + i
      if (dx < 0 || dx >= dst.width) continue
      const s = (j * src.width + i) * 4
      const d = (dy * dst.width + dx) * 4
      const a = src.data[s + 3] / 255
      if (a >= 1) dst.data.set(src.data.subarray(s, s + 4), d)
      else if (a > 0) {
        const da = dst.data[d + 3] / 255
        const oa = a + da * (1 - a)
        for (let k = 0; k < 3; k++)
          dst.data[d + k] = Math.round((src.data[s + k] * a + dst.data[d + k] * da * (1 - a)) / (oa || 1))
        dst.data[d + 3] = Math.round(oa * 255)
      }
    }
  }
}

/** 有内容（不透明）的范围；整张图都透明时返回 null */
export function contentBox(img: Img, threshold = 12) {
  let x0 = img.width
  let y0 = img.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** 有没有真正的透明（不是整张图都不透明） */
export function hasAlpha(img: Img) {
  let clear = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) clear++
  return clear > img.width * img.height * 0.002
}

/**
 * 把纯绿底（#00FF00 的色键）抠成透明，并去掉边缘的绿色溢色。
 * 只有四个角都是绿色时才抠：角上不是绿色说明这张图没有按要求画绿底，原样返回
 */
export function chromaKey(img: Img): Img {
  const { width, height, data } = img
  const green = (x: number, y: number) => {
    const o = (y * width + x) * 4
    return data[o + 1] > 150 && data[o + 1] - Math.max(data[o], data[o + 2]) > 80
  }
  const m = Math.min(3, width - 1, height - 1)
  const corners = [green(m, m), green(width - 1 - m, m), green(m, height - 1 - m), green(width - 1 - m, height - 1 - m)]
  if (corners.filter(Boolean).length < 3) return img
  const out = new Uint8Array(data)
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i]
    const g = out[i + 1]
    const b = out[i + 2]
    // 绿色比红蓝高多少：越高越像背景
    const d = g - Math.max(r, b)
    if (d > 90) out[i + 3] = 0
    else if (d > 25) {
      out[i + 3] = Math.round(out[i + 3] * (1 - (d - 25) / 65))
      out[i + 1] = Math.max(r, b) + Math.round((g - Math.max(r, b)) * 0.15)
    } else if (d > 8) out[i + 1] = Math.max(r, b) + Math.round(d * 0.5)
  }
  return { width, height, data: out }
}

/**
 * 色键没抠掉时的补救：模型没画纯绿底、而是画了别的纯色底（白、灰、黑、浅色）时，
 * 从四条边开始，把和边上颜色接近、连成一片的像素变透明，边缘按颜色差做半透明过渡。
 * 边上的颜色不统一（是场景、不是纯色底）时原样返回，不误伤
 */
export function removeFlatBackground(img: Img, tolerance = 28): Img {
  const { width: w, height: h, data } = img
  const edge: number[] = []
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 64))) edge.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 64))) edge.push(y * w, y * w + w - 1)
  const avg = [0, 0, 0]
  for (const p of edge) for (let c = 0; c < 3; c++) avg[c] += data[p * 4 + c] / edge.length
  const dist = (p: number) =>
    Math.max(Math.abs(data[p * 4] - avg[0]), Math.abs(data[p * 4 + 1] - avg[1]), Math.abs(data[p * 4 + 2] - avg[2]))
  // 边上九成以上的点都接近平均色才算纯色底
  if (edge.filter((p) => dist(p) <= tolerance).length < edge.length * 0.9) return img
  const out = new Uint8Array(data)
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)
  while (stack.length) {
    const p = stack.pop()!
    if (seen[p]) continue
    seen[p] = 1
    const d = dist(p)
    if (d > tolerance * 1.6) continue
    // 很接近底色的全透明；稍远的（抗锯齿的边）半透明，不再往里扩
    out[p * 4 + 3] = d <= tolerance ? 0 : Math.round(out[p * 4 + 3] * ((d - tolerance) / (tolerance * 0.6)))
    if (d > tolerance) continue
    const x = p % w
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (p >= w) stack.push(p - w)
    if (p < w * (h - 1)) stack.push(p + w)
  }
  return { width: w, height: h, data: out }
}
