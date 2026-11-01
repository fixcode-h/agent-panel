import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Session } from './design-mcp.ts'
import { crop, decodePng, encodePng, resize, type Img } from './image.ts'

/**
 * 截图和模板的同一块做像素对比：AI 以前只能用 view_image 分别看两张图目测，对不齐也说不出差几像素。
 * 这里给出：
 * - 相似度（按亮度的平均差算，100 是一模一样）
 * - 最佳对齐偏移：截图往哪个方向挪多少像素和模板最吻合（在边缘图上小范围搜索，抗配色差异）
 * - 差异热力图和左右对照图，AI 用读图能力看哪里不一样
 * 两张图先缩放到同样的尺寸（设计稿坐标里的这一块），再按 work 的分辨率算，几百像素以内很快
 */

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

export interface CompareResult {
  /** 0~100，100 一模一样 */
  score: number
  /** 截图往右（正）/ 左（负）挪多少设计稿像素和模板最吻合 */
  dx: number
  dy: number
  /** 挪过以后的相似度 */
  aligned: number
  /** 差异热力图（越红差得越多），和左右对照图（左截图、右模板） */
  heat: Img
  side: Img
}

/** 亮度（0~255） */
function luma(img: Img) {
  const out = new Float32Array(img.width * img.height)
  for (let i = 0; i < out.length; i++) {
    const d = img.data
    // 透明的地方按黑色算：截图的透明区和模板的深色背景对得上
    const a = d[i * 4 + 3] / 255
    out[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a
  }
  return out
}

/** 边缘强度（简单的梯度）：比较边缘而不是颜色，配色有出入时也能对齐 */
function edges(l: Float32Array, w: number, h: number) {
  const out = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      out[i] = Math.abs(l[i + 1] - l[i - 1]) + Math.abs(l[i + w] - l[i - w])
    }
  return out
}

/** a 挪 (dx, dy) 后和 b 的平均绝对差（只算重叠的部分） */
function meanDiff(a: Float32Array, b: Float32Array, w: number, h: number, dx: number, dy: number) {
  let sum = 0
  let n = 0
  for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y++)
    for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x++) {
      sum += Math.abs(a[(y - dy) * w + (x - dx)] - b[y * w + x])
      n++
    }
  return n ? sum / n : 255
}

export function compareImages(
  shot: Img,
  template: Img,
  /** 设计稿尺寸：两张图都先缩放到它，region 按它的坐标 */
  size: { X: number; Y: number },
  region?: Region,
  /** 搜索对齐偏移的范围（设计稿像素）：不写时按这一块的大小定（边长的 8%，24～160） */
  search?: number,
): CompareResult {
  const r = region ?? { x: 0, y: 0, w: size.X, h: size.Y }
  // 两张图缩放到设计稿尺寸再裁同一块
  const a0 = crop(resize(shot, size.X, size.Y), r.x, r.y, r.w, r.h)
  const b0 = crop(resize(template, size.X, size.Y), r.x, r.y, r.w, r.h)
  // 按长边不超过 320 的分辨率算，偏移再换算回设计稿像素
  const k = Math.min(1, 320 / Math.max(a0.width, a0.height))
  const w = Math.max(8, Math.round(a0.width * k))
  const h = Math.max(8, Math.round(a0.height * k))
  const a = resize(a0, w, h)
  const b = resize(b0, w, h)
  const la = luma(a)
  const lb = luma(b)
  const score = Math.round(Math.max(0, 100 - (meanDiff(la, lb, w, h, 0, 0) / 255) * 100 * 2))
  const ea = edges(la, w, h)
  const eb = edges(lb, w, h)
  const span = search ?? Math.min(160, Math.max(24, Math.round(Math.max(r.w, r.h) * 0.08)))
  const range = Math.max(1, Math.round(span * k))
  let best = { dx: 0, dy: 0, d: meanDiff(ea, eb, w, h, 0, 0) }
  // 差不多好时选挪得少的：纯色块上任何偏移都一样，不报虚假的偏移
  const tryAt = (dx: number, dy: number) => {
    const d = meanDiff(ea, eb, w, h, dx, dy)
    if (d < best.d - 0.5) best = { dx, dy, d }
  }
  // 先隔一格粗搜整个范围，再在最好的位置附近逐格细搜：范围大时也快
  for (let dy = -range; dy <= range; dy += 2) for (let dx = -range; dx <= range; dx += 2) tryAt(dx, dy)
  const c = { ...best }
  for (let dy = c.dy - 2; dy <= c.dy + 2; dy++) for (let dx = c.dx - 2; dx <= c.dx + 2; dx++) tryAt(dx, dy)
  const aligned = Math.round(Math.max(0, 100 - (meanDiff(la, lb, w, h, best.dx, best.dy) / 255) * 100 * 2))
  // 热力图：差得越多越红，叠在模板的灰度上，看得出是哪一块
  const heat: Img = { width: w, height: h, data: new Uint8Array(w * h * 4) }
  for (let i = 0; i < w * h; i++) {
    const d = Math.min(1, Math.abs(la[i] - lb[i]) / 96)
    const g = lb[i] * 0.5
    heat.data[i * 4] = Math.round(g + (255 - g) * d)
    heat.data[i * 4 + 1] = Math.round(g * (1 - d))
    heat.data[i * 4 + 2] = Math.round(g * (1 - d))
    heat.data[i * 4 + 3] = 255
  }
  const side: Img = { width: w * 2 + 4, height: h, data: new Uint8Array((w * 2 + 4) * h * 4) }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w * 2 + 4; x++) {
      const o = (y * (w * 2 + 4) + x) * 4
      const src = x < w ? a : x >= w + 4 ? b : undefined
      const sx = x < w ? x : x - w - 4
      if (!src) {
        side.data.set([255, 0, 255, 255], o)
        continue
      }
      const i = (y * w + sx) * 4
      side.data.set([src.data[i], src.data[i + 1], src.data[i + 2], 255], o)
    }
  return { score, dx: Math.round(best.dx / k), dy: Math.round(best.dy / k), aligned, heat, side }
}

// ---- 设计工具 compare_template ----

/** compare_template：截一张当前画布，和确认的模板（或指定的原画）比同一块，返回数字和对照图 */
export async function compareTool(
  s: Session,
  a: { region?: unknown; concept?: unknown },
): Promise<{ text: string; isError?: boolean }> {
  const fail = (text: string) => ({ text, isError: true })
  const cid = typeof a.concept === 'string' && a.concept ? a.concept : (s.design.concept?.approved ?? '')
  if (!cid) return fail('还没有确认的效果图模板：先让用户挑一张原画「用这张做模板」，或者 concept 写原画 id')
  const file = s.files.conceptPath(cid)
  if (!file) return fail(`没有原画 ${cid}`)
  const tpl = decodePng(await readFile(file).catch(() => Buffer.alloc(0)))
  if (!tpl) return fail(`原画 ${cid} 不是 PNG，没法逐像素对比；用 view_image 看 "concept:${cid}" 和截图对照`)
  if (!s.files.capture) return fail('这里截不了图')
  let shot: Img | null
  try {
    shot = decodePng((await s.files.capture(s, '')).png)
  } catch (e) {
    return fail((e as Error).message)
  }
  if (!shot) return fail('截图读不出来')
  const size = s.designSize ?? s.design.designSize
  const n = (v: unknown) => (typeof v === 'string' ? parseFloat(v) : Number(v))
  const raw = a.region as Record<string, unknown> | undefined
  let region: Region | undefined
  if (raw) {
    const r = { x: n(raw.x ?? 0), y: n(raw.y ?? 0), w: n(raw.w), h: n(raw.h) }
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w < 8 || r.h < 8)
      return fail('region 要写 {"x","y","w","h"}（设计稿像素，宽高至少 8）')
    const x = Math.max(0, Math.min(Math.round(r.x), size.X - 8))
    const y = Math.max(0, Math.min(Math.round(r.y), size.Y - 8))
    region = { x, y, w: Math.min(Math.round(r.w), size.X - x), h: Math.min(Math.round(r.h), size.Y - y) }
  }
  const res = compareImages(shot, tpl, size, region)
  await mkdir(path.join(s.files.dir, 'views'), { recursive: true })
  const tag = ++s.views
  const heatFile = path.join(s.files.dir, 'views', `compare-${tag}-heat.png`)
  const sideFile = path.join(s.files.dir, 'views', `compare-${tag}-side.png`)
  await writeFile(heatFile, encodePng(res.heat))
  await writeFile(sideFile, encodePng(res.side))
  const where = region
    ? `区域 x=${region.x} y=${region.y} 宽=${region.w} 高=${region.h}`
    : `整个画布 ${size.X}×${size.Y}`
  const move =
    res.dx || res.dy
      ? `截图里的内容${res.dx ? `往${res.dx > 0 ? '右' : '左'}挪 ${Math.abs(res.dx)}` : ''}${res.dx && res.dy ? '、' : ''}${res.dy ? `往${res.dy > 0 ? '下' : '上'}挪 ${Math.abs(res.dy)}` : ''} 像素和模板最吻合（挪过以后相似度 ${res.aligned}）`
      : '位置已经对齐（没有更好的偏移）'
  return {
    text: [
      `和模板 ${cid} 对比（${where}）：相似度 ${res.score}/100。`,
      move,
      `对照图 ${sideFile}（左边截图、右边模板），差异热力图 ${heatFile}（越红差得越多）：用读图的能力看这两个文件，找出哪里不一样再改。`,
      '相似度只看亮度，配色、材质还没出图时偏低是正常的；位置和大小对齐看偏移和热力图里的红边。',
    ].join('\n'),
  }
}
