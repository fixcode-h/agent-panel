import { deflateSync, inflateSync } from 'node:zlib'

/**
 * 图片处理（只处理 PNG，不依赖第三方库）：UI 设计里用来
 * - 把生成的图精确裁成设计里要的尺寸（模型出图的尺寸和比例不由我们定）
 * - 把纯绿底抠成透明（Codex 画的图）、一张图里切出多个图标（图标表）
 * - 给 AI 看参考图时画上坐标格、放大一块区域、取主色，让它量得准
 * 解不开的格式（JPEG、WebP、隔行扫描的 PNG）返回 null，调用方原样使用。
 */

export interface Img {
  width: number
  height: number
  /** RGBA，每像素 4 字节 */
  data: Uint8Array
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(b: Buffer) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function decodePng(buf: Buffer): Img | null {
  try {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null
    let off = 8
    let width = 0
    let height = 0
    let depth = 0
    let color = 0
    let interlace = 0
    let palette: Buffer | undefined
    let trns: Buffer | undefined
    const idat: Buffer[] = []
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off)
      const type = buf.toString('ascii', off + 4, off + 8)
      const body = buf.subarray(off + 8, off + 8 + len)
      if (type === 'IHDR') {
        width = body.readUInt32BE(0)
        height = body.readUInt32BE(4)
        depth = body[8]
        color = body[9]
        interlace = body[12]
      } else if (type === 'PLTE') palette = body
      else if (type === 'tRNS') trns = body
      else if (type === 'IDAT') idat.push(body)
      else if (type === 'IEND') break
      off += 12 + len
    }
    if (!width || !height || interlace || width * height > 40_000_000) return null
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color as 0 | 2 | 3 | 4 | 6]
    if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null
    const bpp = Math.max(1, (channels * depth) / 8)
    const stride = Math.ceil((width * channels * depth) / 8)
    const raw = inflateSync(Buffer.concat(idat))
    if (raw.length < (stride + 1) * height) return null
    // 去掉每行的滤波
    const px = Buffer.alloc(stride * height)
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)]
      const src = y * (stride + 1) + 1
      const dst = y * stride
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[dst + x - bpp] : 0
        const b = y > 0 ? px[dst - stride + x] : 0
        const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0
        let v = raw[src + x]
        if (f === 1) v += a
        else if (f === 2) v += b
        else if (f === 3) v += (a + b) >> 1
        else if (f === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        px[dst + x] = v & 0xff
      }
    }
    const out = new Uint8Array(width * height * 4)
    const sample = (y: number, i: number) => {
      // 第 i 个样本（一行里按通道排）
      if (depth === 8) return px[y * stride + i]
      if (depth === 16) return px[y * stride + i * 2]
      const bit = i * depth
      const byte = px[y * stride + (bit >> 3)]
      return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
    }
    const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        if (color === 6) {
          for (let k = 0; k < 4; k++) out[o + k] = sample(y, x * 4 + k)
        } else if (color === 2) {
          for (let k = 0; k < 3; k++) out[o + k] = sample(y, x * 3 + k)
          out[o + 3] = 255
        } else if (color === 0) {
          const g = Math.round(sample(y, x) * scale)
          out[o] = out[o + 1] = out[o + 2] = g
          out[o + 3] = 255
        } else if (color === 4) {
          out[o] = out[o + 1] = out[o + 2] = sample(y, x * 2)
          out[o + 3] = sample(y, x * 2 + 1)
        } else {
          const i = sample(y, x)
          out[o] = palette?.[i * 3] ?? 0
          out[o + 1] = palette?.[i * 3 + 1] ?? 0
          out[o + 2] = palette?.[i * 3 + 2] ?? 0
          out[o + 3] = trns && i < trns.length ? trns[i] : 255
        }
      }
    return { width, height, data: out }
  } catch {
    return null
  }
}

const chunk = (type: string, body: Buffer) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

export function encodePng(img: Img): Buffer {
  const { width, height, data } = img
  // 全不透明的存成 RGB，文件小一点
  let opaque = true
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      opaque = false
      break
    }
  const ch = opaque ? 3 : 4
  const raw = Buffer.alloc((width * ch + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * ch + 1)
    raw[row] = 1 // Sub 滤波：对平坦的图压缩得更小
    for (let x = 0; x < width; x++)
      for (let k = 0; k < ch; k++) {
        const v = data[(y * width + x) * 4 + k]
        const left = x > 0 ? data[(y * width + x - 1) * 4 + k] : 0
        raw[row + 1 + x * ch + k] = (v - left) & 0xff
      }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = opaque ? 2 : 6
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
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

/**
 * 把图精确变成 width×height：
 * - 透明的元素先裁掉四周的空白，再放进去：比例接近（相差 15% 以内）直接拉伸铺满，差得多就保持比例居中，其余透明
 * - 不透明的图：比例接近直接缩放，差得多就按比例铺满后裁掉多出的部分（居中）
 * stretch 时（九宫格）总是直接缩放，边角和中心的比例在 UE 里由九宫格处理
 */
export function fitExact(img: Img, width: number, height: number, o: { stretch?: boolean; trim?: boolean } = {}): Img {
  let src = img
  const transparent = hasAlpha(img)
  if (transparent && o.trim !== false && !o.stretch) {
    const box = contentBox(img)
    if (box) src = crop(img, box.x, box.y, box.w, box.h)
  }
  const ratio = src.width / src.height
  const want = width / height
  const close = Math.abs(ratio / want - 1) <= 0.15
  if (o.stretch || close) return resize(src, width, height)
  if (transparent) {
    const k = Math.min(width / src.width, height / src.height)
    const w = Math.max(1, Math.round(src.width * k))
    const h = Math.max(1, Math.round(src.height * k))
    const out = blank(width, height)
    paste(out, resize(src, w, h), Math.round((width - w) / 2), Math.round((height - h) / 2))
    return out
  }
  const k = Math.max(width / src.width, height / src.height)
  const w = Math.max(width, Math.round(src.width * k))
  const h = Math.max(height, Math.round(src.height * k))
  return crop(resize(src, w, h), Math.round((w - width) / 2), Math.round((h - height) / 2), width, height)
}

/** 生成的图存成设计里要的精确尺寸；解不开（不是 PNG）时原样返回 */
export function normalizeGenerated(
  buf: Buffer,
  want: { width: number; height: number; transparent: boolean; nineSlice?: unknown },
  o: { key?: boolean } = {},
): Buffer {
  const img = decodePng(buf)
  if (!img) return buf
  let cur = img
  // 要透明的图：画的是纯绿底就抠掉；没按要求画绿底、但底是纯色的，按边上的颜色抠
  if (want.transparent && o.key !== false) {
    cur = chromaKey(cur)
    if (!hasAlpha(cur)) cur = removeFlatBackground(cur)
  }
  const exact = cur.width === want.width && cur.height === want.height && cur === img
  if (exact) return buf
  let fitted = fitExact(cur, want.width, want.height, { stretch: !!want.nineSlice, trim: want.transparent })
  // 缩得很小（例如 1024 的图缩成 96 的图标）时细节会发虚：按缩小的倍数补一点锐化
  const k = Math.min(cur.width / want.width, cur.height / want.height)
  if (k > 2) fitted = sharpen(fitted, Math.min(0.5, 0.15 * Math.log2(k)))
  return encodePng(fitted)
}

/** 锐化（反锐化掩模，3×3）：只动颜色不动透明度，amount 0~1 */
export function sharpen(img: Img, amount = 0.35): Img {
  const { width: w, height: h, data } = img
  const out = new Uint8Array(data)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4
      if (data[o + 3] === 0) continue
      for (let c = 0; c < 3; c++) {
        let blur = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) blur += data[((y + dy) * w + x + dx) * 4 + c]
        const v = data[o + c] + amount * (data[o + c] - blur / 9) * 2
        out[o + c] = Math.max(0, Math.min(255, Math.round(v)))
      }
    }
  return { width: w, height: h, data: out }
}

/** 把一张图标表按 cols×rows 平均切开，每格再裁掉空白、精确放进各自的尺寸 */
export function sliceSheet(
  buf: Buffer,
  cols: number,
  rows: number,
  wants: { width: number; height: number; transparent: boolean }[],
  o: { key?: boolean } = {},
): (Buffer | null)[] {
  const img = decodePng(buf)
  if (!img) return wants.map(() => null)
  const sheet = wants.some((w) => w.transparent) && o.key !== false ? chromaKey(img) : img
  const cw = sheet.width / cols
  const ch = sheet.height / rows
  return wants.map((w, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    if (r >= rows) return null
    const cell = crop(sheet, c * cw, r * ch, cw, ch)
    // 整格都是空的：这个图标没画出来
    if (w.transparent && !contentBox(cell)) return null
    const out = fitExact(cell, w.width, w.height, { trim: w.transparent })
    // 从大格子缩成小图标会变软：缩得多时轻微锐化，小尺寸下边缘清楚
    return encodePng(cw / w.width > 1.5 ? sharpen(out, 0.35) : out)
  })
}

/** 主要颜色：按颜色分组数像素，返回最多的几种（忽略透明的） */
export function palette(img: Img, n = 8) {
  const bins = new Map<number, { c: number; r: number; g: number; b: number }>()
  let total = 0
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue
    const r = img.data[i]
    const g = img.data[i + 1]
    const b = img.data[i + 2]
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const e = bins.get(k)
    total++
    if (e) {
      e.c++
      e.r += r
      e.g += g
      e.b += b
    } else bins.set(k, { c: 1, r, g, b })
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0')
  return [...bins.values()]
    .sort((a, b) => b.c - a.c)
    .slice(0, n)
    .map((e) => ({
      color: `#${hex(e.r / e.c)}${hex(e.g / e.c)}${hex(e.b / e.c)}`.toUpperCase(),
      percent: Math.round((e.c / Math.max(1, total)) * 1000) / 10,
    }))
}

export function pixelAt(img: Img, x: number, y: number) {
  x = Math.max(0, Math.min(img.width - 1, Math.round(x)))
  y = Math.max(0, Math.min(img.height - 1, Math.round(y)))
  const o = (y * img.width + x) * 4
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  const a = img.data[o + 3]
  return `#${hex(img.data[o])}${hex(img.data[o + 1])}${hex(img.data[o + 2])}${a < 255 ? hex(a) : ''}`.toUpperCase()
}

// 3×5 的数字点阵，给坐标格标数字用
const DIGITS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
}

function label(img: Img, text: string, x: number, y: number, k: number) {
  const w = text.length * 4 * k + k
  const h = 5 * k + 2 * k
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const px = x + i
      const py = y + j
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue
      img.data.set([0, 0, 0, 215], (py * img.width + px) * 4)
    }
  ;[...text].forEach((ch, n) => {
    const bits = DIGITS[ch]
    if (!bits) return
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 3; i++)
        if (bits[j * 3 + i] === '1')
          for (let b = 0; b < k * k; b++) {
            const px = x + k + n * 4 * k + i * k + (b % k)
            const py = y + k + j * k + Math.floor(b / k)
            if (px >= 0 && py >= 0 && px < img.width && py < img.height)
              img.data.set([255, 235, 59, 255], (py * img.width + px) * 4)
          }
  })
}

/** 一个整齐的格距（1、2、5 × 10 的几次方），让一条边大约分成 10 格 */
export function gridStep(span: number) {
  const raw = span / 10
  const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)))
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10
}

/**
 * 给图片画上坐标格：线上标的是「原图像素」坐标（origin 是这块图左上角在原图里的位置，zoom 是放大倍数），
 * AI 看图时按格子读位置和大小，比目测准得多
 */
export function drawGrid(img: Img, o: { origin: { x: number; y: number }; zoom: number; step: number }): Img {
  const out: Img = { ...img, data: new Uint8Array(img.data) }
  const k = Math.max(1, Math.round(Math.min(img.width, img.height) / 520))
  const line = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return
    const p = (y * out.width + x) * 4
    for (let c = 0; c < 3; c++) out.data[p + c] = Math.round(out.data[p + c] * 0.45 + [255, 0, 220][c] * 0.55)
    out.data[p + 3] = 255
  }
  const first = (v: number) => Math.ceil(v / o.step) * o.step
  for (let gx = first(o.origin.x); (gx - o.origin.x) * o.zoom < out.width; gx += o.step) {
    const x = Math.round((gx - o.origin.x) * o.zoom)
    for (let y = 0; y < out.height; y++) for (let t = 0; t < k; t++) line(x + t, y)
  }
  for (let gy = first(o.origin.y); (gy - o.origin.y) * o.zoom < out.height; gy += o.step) {
    const y = Math.round((gy - o.origin.y) * o.zoom)
    for (let x = 0; x < out.width; x++) for (let t = 0; t < k; t++) line(x, y + t)
  }
  // 数字：横轴的标在上沿，纵轴的标在左沿
  const kk = Math.max(2, k * 2)
  for (let gx = first(o.origin.x); (gx - o.origin.x) * o.zoom < out.width; gx += o.step)
    label(out, String(gx), Math.round((gx - o.origin.x) * o.zoom) + 2, 1, kk)
  for (let gy = first(o.origin.y); (gy - o.origin.y) * o.zoom < out.height; gy += o.step)
    if (gy !== o.origin.y || o.origin.y > 0) label(out, String(gy), 1, Math.round((gy - o.origin.y) * o.zoom) + 2, kk)
  return out
}

/**
 * 蒙版图（给 ComfyUI 的 inpaint 用）：黑底，涂过的区域白色，橡皮擦的笔画把涂过的地方擦回黑色。
 * 笔画按设计稿像素画，尺寸和原画一致；ComfyUI 的 ImageToMask 取红色通道当蒙版
 */
export function maskImage(
  strokes: { erase: boolean; w: number; points: number[] }[],
  width: number,
  height: number,
): Img {
  const img = blank(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), [0, 0, 0, 255])
  const stamp = (cx: number, cy: number, r: number, v: number) => {
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(img.width - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(img.height - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue
        const o = (y * img.width + x) * 4
        img.data[o] = v
        img.data[o + 1] = v
        img.data[o + 2] = v
        img.data[o + 3] = 255
      }
  }
  for (const s of strokes) {
    const v = s.erase ? 0 : 255
    const r = Math.max(0.5, s.w / 2)
    const p = s.points
    if (p.length < 2) continue
    // 一笔是一条圆头粗线：沿轨迹按半径的一半打圆点，点之间不会断
    for (let i = 0; i + 1 < p.length; i += 2) {
      stamp(p[i], p[i + 1], r, v)
      if (i + 3 >= p.length) continue
      const x1 = p[i + 2]
      const y1 = p[i + 3]
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - p[i], y1 - p[i + 1]) / Math.max(1, r / 2)))
      for (let k = 1; k < steps; k++) {
        const t = k / steps
        stamp(p[i] + (x1 - p[i]) * t, p[i + 1] + (y1 - p[i + 1]) * t, r, v)
      }
    }
  }
  return img
}
