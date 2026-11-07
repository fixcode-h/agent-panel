import { resize, type Img } from '../raster.ts'

/**
 * 两张图有多像（0~1，1 是一模一样）：原画抠出来的切图、精修重画的切图、还原后的截图都拿它和原画比。
 * 两张图先缩到同一个小尺寸（长边 side），透明的地方铺中灰（透明和黑底不算一样），
 * 结构按亮度算 SSIM（8×8 窗口、步长 4），颜色按 RGB 平均差算，结构占七成。
 * 只看结构会把「形状对、颜色全错」判成很像；只看颜色会把「糊成一片」判成很像
 */
export function similarity(a: Img, b: Img, side = 96): number {
  const ratio = a.width / Math.max(1, a.height)
  const w = Math.max(8, Math.round(ratio >= 1 ? side : side * ratio))
  const h = Math.max(8, Math.round(ratio >= 1 ? side / ratio : side))
  const pa = flatten(resize(a, w, h))
  const pb = flatten(resize(b, w, h))
  const s = ssim(luma(pa), luma(pb), w, h)
  let diff = 0
  for (let i = 0; i < pa.length; i++) diff += Math.abs(pa[i] - pb[i])
  const color = 1 - diff / pa.length / 255
  return Math.max(0, Math.min(1, 0.7 * s + 0.3 * color))
}

/** 按透明度铺在中灰上，只留 RGB */
function flatten(img: Img) {
  const out = new Float32Array(img.width * img.height * 3)
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    const a = img.data[i + 3] / 255
    for (let c = 0; c < 3; c++) out[j + c] = img.data[i + c] * a + 128 * (1 - a)
  }
  return out
}

function luma(rgb: Float32Array) {
  const out = new Float32Array(rgb.length / 3)
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]
  return out
}

/** 平均 SSIM：图小于一个窗口时整张当一个窗口 */
export function ssim(a: Float32Array, b: Float32Array, w: number, h: number, win = 8, step = 4) {
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  const ww = Math.min(win, w)
  const wh = Math.min(win, h)
  let sum = 0
  let n = 0
  for (let y = 0; y + wh <= h; y += step)
    for (let x = 0; x + ww <= w; x += step) {
      let ma = 0
      let mb = 0
      for (let j = 0; j < wh; j++)
        for (let i = 0; i < ww; i++) {
          ma += a[(y + j) * w + x + i]
          mb += b[(y + j) * w + x + i]
        }
      const k = ww * wh
      ma /= k
      mb /= k
      let va = 0
      let vb = 0
      let cov = 0
      for (let j = 0; j < wh; j++)
        for (let i = 0; i < ww; i++) {
          const da = a[(y + j) * w + x + i] - ma
          const db = b[(y + j) * w + x + i] - mb
          va += da * da
          vb += db * db
          cov += da * db
        }
      va /= k
      vb /= k
      cov /= k
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      n++
    }
  return n ? sum / n : 1
}
