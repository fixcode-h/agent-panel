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
