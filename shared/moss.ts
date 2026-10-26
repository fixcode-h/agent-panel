import { canvasSlotRect, isHiddenVisibility, type Widget } from './umg.ts'

/**
 * MOSS-Image 的布局 JSON：格式按 OpenMOSS 官方 compile_prompt.py：
 * { "summary": { "caption": "..." }, "items": [{ "label": "text|object|character", "caption": "...", "text": "...", "bbox": [...] }],
 *   "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx" }
 *
 * bbox 不是设计稿的左上原点，而是以画布中心为原点、像素单位、yxyx 顺序；
 * width / height 必须等于实际出图尺寸，否则位置会偏。这里把设计稿像素换算成实际出图的像素。
 */

export interface MossLayoutRect {
  x: number
  y: number
  w: number
  h: number
}

export interface MossLayoutItem {
  /** text 是要渲染的文字，object 是画面里的物体 */
  label: 'text' | 'object'
  /** 这块内容的视觉描述（英文） */
  caption: string
  /** label 为 text 时的文字内容，模型原样渲染 */
  text?: string
  /** 设计稿像素，左上原点 */
  rect: MossLayoutRect
}

export interface MossLayoutSize {
  width: number
  height: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * 设计稿像素 → 实际出图像素 → 中心原点、yxyx。
 * 左 / 上向下取整、右 / 下向上取整，再减去画布中心（和官方脚本一致）。
 * 换算后没有面积的框返回 undefined（模型不接受空框）。
 */
export function mossBbox(
  rect: MossLayoutRect,
  source: MossLayoutSize,
  size: MossLayoutSize,
): [number, number, number, number] | undefined {
  const sx = size.width / source.width
  const sy = size.height / source.height
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return undefined
  const x1 = clamp(Math.floor(rect.x * sx), 0, size.width)
  const y1 = clamp(Math.floor(rect.y * sy), 0, size.height)
  const x2 = clamp(Math.ceil((rect.x + rect.w) * sx), 0, size.width)
  const y2 = clamp(Math.ceil((rect.y + rect.h) * sy), 0, size.height)
  if (x2 <= x1 || y2 <= y1) return undefined
  const cx = Math.floor(size.width / 2)
  const cy = Math.floor(size.height / 2)
  return [y1 - cy, x1 - cx, y2 - cy, x2 - cx]
}

/**
 * 编译成官方要求的单行 JSON；没有有效布局项时返回 undefined，调用方回退成普通描述。
 * size 必须是实际出图尺寸，且宽高是 16 的倍数（localSize 生成的尺寸已经满足）。
 */
export function mossLayoutJson(
  items: MossLayoutItem[],
  o: { source: MossLayoutSize; size: MossLayoutSize; caption?: string },
): string | undefined {
  const list = items.flatMap((item) => {
    const bbox = mossBbox(item.rect, o.source, o.size)
    if (!bbox) return []
    if (item.label === 'text') return [{ label: 'text', caption: item.caption, text: item.text ?? '', bbox }]
    return [{ label: 'object', caption: item.caption, bbox }]
  })
  if (!list.length) return undefined
  return JSON.stringify({
    summary: { caption: o.caption ?? '' },
    items: list,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  })
}

const brushRef = (b: unknown) => {
  const ref = (b as { ResourceObject?: unknown } | undefined)?.ResourceObject
  return typeof ref === 'string' && ref.startsWith('img:') ? ref : ''
}

/** 控件用到的图片（img:<id>）：image / border / button / progress / 网页的 picture、frame 都认 */
function imageRef(w: Widget): string {
  const p = w.Properties ?? {}
  const refs = [
    brushRef(p.Brush),
    brushRef(p.Background),
    brushRef(p.WidgetStyle?.Normal),
    brushRef(p.WidgetStyle?.BackgroundImage),
    brushRef(p.WidgetStyle?.FillImage),
    brushRef(p.FillImage),
    brushRef(p.BackgroundImage),
    typeof p.Src === 'string' ? p.Src : '',
    typeof p.BackgroundImage === 'string' ? p.BackgroundImage : '',
  ]
  return refs.find((x) => x.startsWith('img:')) ?? ''
}

/** 文字块的视觉描述：字号、粗细、对齐、颜色；文字内容放在 text 里，不在这里重复 */
function textCaption(w: Widget): string {
  const p = w.Properties ?? {}
  const ueSize = Number(p.Font?.Size ?? p.FontSize)
  // UMG 的 Font.Size 换成屏幕像素大约是 4/3；网页的字号本来就是像素
  const px = Number.isFinite(ueSize) && ueSize > 0 ? Math.round(w.Type === 'Text' ? ueSize : (ueSize * 4) / 3) : 24
  const bold = /Bold/i.test(String(p.Font?.TypefaceFontName ?? '')) || Number(p.FontWeight) >= 600
  const align = String(p.Justification ?? p.TextAlign ?? 'left').toLowerCase()
  const color = String(p.ColorAndOpacity ?? p.Color ?? '')
    .slice(0, 7)
    .toUpperCase()
  return `UI text label: ${px}px${bold ? ' bold' : ''}, ${align} aligned${color ? `, color ${color}` : ''}`
}

/**
 * 从设计稿的控件树取布局项：只取有实际文字的文字块，和用到了有描述图片的控件。
 * 坐标按 CanvasPanel 的插槽逐层累加；其它容器（横竖排、边框）里的控件量不出像素位置，
 * 一并跳过 —— 宁可少给几项，也不要给错的坐标。根控件是网页的 Frame 时同样返回空。
 */
export function designLayoutItems(
  root: Widget | undefined,
  images: { id: string; prompt: string }[],
  size: { X: number; Y: number },
  limit = 24,
): MossLayoutItem[] {
  const out: MossLayoutItem[] = []
  if (!root) return out
  const byId = new Map(images.map((i) => [i.id, i]))
  const take = (w: Widget, rect: MossLayoutRect) => {
    // 设计里藏起来的控件不画出来，也不能让模型在原画里画出来
    if (isHiddenVisibility(w.Properties?.Visibility)) return
    if (w.Type === 'TextBlock' || w.Type === 'Text') {
      const text = String(w.Properties?.Text ?? '').trim()
      if (!text || text === 'Text Block' || text === 'Text') return
      out.push({ label: 'text', caption: textCaption(w), text, rect })
      return
    }
    const ref = imageRef(w)
    if (!ref) return
    const caption = (byId.get(ref.slice(4))?.prompt ?? '').trim()
    if (!caption) return
    out.push({ label: 'object', caption, rect })
  }
  const visit = (w: Widget, rect: MossLayoutRect) => {
    // 只有 CanvasPanel 的子控件有像素坐标，其它容器的位置由布局自动算
    if (w.Type !== 'CanvasPanel') return
    for (const child of w.Children ?? []) {
      if (out.length >= limit) return
      if (isHiddenVisibility(child.Properties?.Visibility)) continue
      const r = canvasSlotRect(child.Slot, { w: rect.w, h: rect.h })
      const abs = { x: rect.x + r.x, y: rect.y + r.y, w: r.w, h: r.h }
      take(child, abs)
      visit(child, abs)
    }
  }
  visit(root, { x: 0, y: 0, w: size.X, h: size.Y })
  return out
}
