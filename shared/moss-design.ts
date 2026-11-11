import { canvasSlotRect, isHiddenVisibility, type Widget } from './umg.ts'
import type { MossLayoutItem, MossLayoutRect } from './moss.ts'

/**
 * 从 UI 设计稿的控件树取 MOSS-Image 的布局项（从 shared/moss.ts 拆出）：布局 JSON 的格式是面板的 ComfyUI 出图用的，
 * 留在面板；从设计稿取位置只有 UI 设计用，跟着设计走。
 */

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
