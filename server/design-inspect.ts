import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Session } from './design-mcp.ts'
import {
  contentBox,
  crop,
  decodePng,
  drawGrid,
  encodePng,
  gridStep,
  hasAlpha,
  palette,
  pixelAt,
  resize,
} from './image.ts'
import { imageSize } from './zip.ts'

/** 设计工具里看图的两个：inspect_image 量尺寸和颜色，view_image 画坐标格、放大一块存成文件 */

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** 找 source 指的图：附件（从 1 数起，或写文件名）或设计里已有的图 */
function sourceFile(s: Session, source: string): { file: string; name: string; error?: undefined } | { error: string } {
  const m = /^(attachment|image|concept|screenshot):(.+)$/.exec(source.trim())
  if (!m) return { error: 'source 要写 "attachment:1"、"image:<图片 id>"、"concept:<原画 id>" 或 "screenshot:1"' }
  if (m[1] === 'image') {
    const file = s.files.imagePath(m[2])
    return file ? { file, name: m[2] } : { error: `设计里没有已经生成的图片 ${m[2]}` }
  }
  if (m[1] === 'concept') {
    const file = s.files.conceptPath(m[2])
    return file ? { file, name: m[2] } : { error: `没有原画 ${m[2]}` }
  }
  if (m[1] === 'screenshot') {
    const n = m[2] === 'latest' ? s.shots.length : Number(m[2])
    const file = s.shots[n - 1]
    return file ? { file, name: `screenshot-${n}` } : { error: `没有第 ${m[2]} 张截图（截过 ${s.shots.length} 张）` }
  }
  const list = s.files.attachments
  const at = /^\d+$/.test(m[2]) ? list[Number(m[2]) - 1] : list.find((x) => x.name === m[2])
  return at ? { file: at.path, name: at.name } : { error: `没有这个附件（共 ${list.length} 个）` }
}

/** inspect_image：量；view_image：画格子、放大，存成文件 */
export async function inspect(s: Session, view: boolean, a: any) {
  const src = sourceFile(s, str(a.source))
  if (src.error !== undefined) return text(src.error, true)
  const buf = await readFile(src.file).catch(() => undefined)
  if (!buf) return text('读不到这张图', true)
  const info = imageSize(buf)
  const img = decodePng(buf)
  if (!info) return text('不是能识别的图片', true)
  // 不是 PNG：只能告诉尺寸，放大、画格子要自己用读图能力看原文件
  if (!img)
    return text(
      `${src.name}：${info.width}×${info.height} 像素（${info.ext}，这个格式不能放大或取色，请直接读原文件 ${src.file}）`,
    )
  // 坐标可能写成 "10px"、漏写：先转成数字，不合法直接告诉 AI（以前 NaN 一路传下去，取色时抛异常、接口回 500）
  const n = (v: unknown) => (typeof v === 'string' ? parseFloat(v) : Number(v))
  let r: { x: number; y: number; w: number; h: number } | undefined
  if (a.region !== undefined) {
    const raw = { x: n(a.region?.x ?? 0), y: n(a.region?.y ?? 0), w: n(a.region?.w), h: n(a.region?.h) }
    if (![raw.x, raw.y, raw.w, raw.h].every(Number.isFinite) || raw.w <= 0 || raw.h <= 0)
      return text('region 要写 {"x","y","w","h"}，都是数字，宽高大于 0（单位是原图像素）', true)
    // 夹到图片范围里：返回的 region、contentBox 都按夹紧后的坐标，不报图片外面的位置
    const x = Math.min(Math.max(0, Math.round(raw.x)), info.width - 1)
    const y = Math.min(Math.max(0, Math.round(raw.y)), info.height - 1)
    r = {
      x,
      y,
      w: Math.max(1, Math.min(Math.round(raw.w), info.width - x)),
      h: Math.max(1, Math.min(Math.round(raw.h), info.height - y)),
    }
  }
  const rx = r?.x ?? 0
  const ry = r?.y ?? 0
  const part = r ? crop(img, rx, ry, r.w, r.h) : img
  const d = s.design.designSize
  // 参考图和设计稿的换算：宽高比不一致时提醒，免得按错的比例算
  const fit =
    Math.abs(info.width / info.height / (d.X / d.Y) - 1) < 0.02
      ? `和设计稿 ${d.X}×${d.Y} 比例一致，原图坐标 × ${(d.X / info.width).toFixed(4)} 就是设计稿坐标`
      : `和设计稿 ${d.X}×${d.Y} 的宽高比不同（${(info.width / info.height).toFixed(3)} 对 ${(d.X / d.Y).toFixed(3)}），换算时按内容要铺满的方式想清楚`
  if (!view) {
    const box = hasAlpha(part) ? contentBox(part) : null
    const rawPts = (Array.isArray(a.points) ? a.points : []).slice(0, 40).map((p: any) => ({ x: n(p?.x), y: n(p?.y) }))
    const badPt = rawPts.findIndex((p: { x: number; y: number }) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    if (badPt >= 0) return text(`points 的第 ${badPt + 1} 个点要写 {"x":数字,"y":数字}（原图像素）`, true)
    const pts = rawPts.map((p: { x: number; y: number }) => {
      const x = Math.min(Math.max(0, Math.round(p.x)), info.width - 1)
      const y = Math.min(Math.max(0, Math.round(p.y)), info.height - 1)
      return { x, y, color: pixelAt(img, x, y) }
    })
    return text(
      JSON.stringify({
        name: src.name,
        size: `${info.width}×${info.height}`,
        ...(r ? { region: { x: rx, y: ry, w: part.width, h: part.height } } : {}),
        aspect: Math.round((part.width / part.height) * 1000) / 1000,
        transparent: hasAlpha(part),
        ...(box ? { contentBox: { x: rx + box.x, y: ry + box.y, w: box.w, h: box.h } } : {}),
        palette: palette(part, 8),
        ...(pts.length ? { points: pts } : {}),
        designSizeNote: fit,
      }),
    )
  }
  const long = Math.max(part.width, part.height)
  // 放大到长边约 900 像素（小的块放大看细节，最多 6 倍），整张大图缩到 1600 以内
  const zoom =
    Number(a.zoom) > 0
      ? Math.min(8, Number(a.zoom))
      : r || long < 600
        ? Math.min(6, 900 / long)
        : long > 1800
          ? 1600 / long
          : 1
  let out = zoom === 1 ? part : resize(part, part.width * zoom, part.height * zoom)
  const step = gridStep(long)
  if (a.grid !== false) out = drawGrid(out, { origin: { x: rx, y: ry }, zoom, step })
  await mkdir(path.join(s.files.dir, 'views'), { recursive: true })
  const file = path.join(s.files.dir, 'views', `view-${++s.views}.png`)
  await writeFile(file, encodePng(out))
  return text(
    [
      `已生成 ${file}，用读图的能力看这个文件。`,
      `原图 ${info.width}×${info.height} 像素${r ? `，这张是其中 x ${rx}–${rx + part.width}、y ${ry}–${ry + part.height} 的一块` : ''}，放大 ${Math.round(zoom * 100) / 100} 倍。`,
      a.grid !== false
        ? `品红色格线每格 ${step} 像素，线边的黄色数字是原图像素坐标（横轴数字在上沿，纵轴数字在左沿）。`
        : '',
      fit,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}
