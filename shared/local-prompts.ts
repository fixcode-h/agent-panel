import type { DesignKind } from './style-types.ts'

/**
 * 本机出图（ComfyUI）的正反提示词（从 shared/design.ts 拆出）：面板的 ComfyUI 出图和 UI 设计都用，
 * UI 设计拆成插件后它留在面板这边。
 */

/** 反向提示词：网页版的图片模型没有单独的反向参数，写成「不能出现」的一行，效果最稳 */
export const GAME_NEGATIVE =
  'text, letters, numbers, words, watermark, signature, logo, UI mockup, screenshot, full screen layout, extra unrelated elements, cropped, cut off, out of frame, blurry, low resolution, pixelated, jpeg artifacts, noise, grain, chromatic aberration, depth of field, perspective tilt, photo background, messy sketch lines, unfinished, inconsistent lighting, deformed or warped shapes'
export const WEB_NEGATIVE =
  'text, letters, watermark, signature, logo, browser window, device frame, screenshot, cropped, blurry, low resolution, pixelated, jpeg artifacts, noise, oversaturated, distorted, deformed, cluttered composition'
export const negativeLine = (...lists: (string | undefined)[]) => {
  const all = lists.flatMap((l) => (l ?? '').split(',')).map((x) => x.trim())
  const uniq = [...new Set(all.filter(Boolean).map((x) => x.toLowerCase()))]
  return uniq.length ? `Negative prompt (none of these may appear): ${uniq.join(', ')}.` : ''
}

/**
 * 本机模型（ComfyUI）的正反提示词：新一代模型（Z-Image、FLUX、Qwen-Image）读得懂完整的描述，
 * 只是把写在正文里的「不能出现」拿出来单独传；SDXL 的文本编码器只看前 77 个词，压成关键词短句
 */
export function localPrompts(
  full: string,
  natural: boolean,
  o: { subject: string; style: string; projectStyle?: string; kind?: DesignKind; chroma?: boolean; negative?: string },
) {
  const lines = full.split('\n')
  const neg = lines.find((l) => l.startsWith('Negative prompt'))
  const negative = neg
    ? neg.replace(/^Negative prompt[^:]*:\s*/, '').replace(/\.$/, '')
    : negativeLine(o.kind === 'web' ? WEB_NEGATIVE : GAME_NEGATIVE, o.negative).replace(/^[^:]*:\s*/, '')
  if (natural) return { prompt: lines.filter((l) => l !== neg).join('\n'), negative }
  const prompt = [
    o.subject.trim(),
    o.kind === 'web' ? 'web illustration' : 'game ui asset',
    o.style.trim(),
    (o.projectStyle ?? '').trim().split(/[.\n]/)[0],
    'isolated, centered, clean sharp edges, high detail, masterpiece',
    o.chroma ? 'on a flat pure green background' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return { prompt, negative }
}
