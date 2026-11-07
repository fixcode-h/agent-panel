import type { Img } from '../raster.ts'

/**
 * 状态派生：按钮的悬停、按下、禁用从常态那张切图算出来，风格一定和原画一致。
 * 规则（设计稿 ④ 的状态表）：悬停亮度 +12%；按下亮度 −10%；禁用去色 70%、不透明度 60%。
 * PSD 里画了的状态用画的，不派生
 */
export type ButtonState = 'hover' | 'pressed' | 'disabled'

export const STATE_RULES: Record<ButtonState, { light: number; gray: number; alpha: number }> = {
  hover: { light: 1.12, gray: 0, alpha: 1 },
  pressed: { light: 0.9, gray: 0, alpha: 1 },
  disabled: { light: 1, gray: 0.7, alpha: 0.6 },
}

export function deriveState(img: Img, s: ButtonState): Img {
  const r = STATE_RULES[s]
  const out = new Uint8Array(img.data.length)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] * (1 - r.gray) + l * r.gray
      out[i + c] = Math.max(0, Math.min(255, Math.round(v * r.light)))
    }
    out[i + 3] = Math.round(d[i + 3] * r.alpha)
  }
  return { width: img.width, height: img.height, data: out }
}
