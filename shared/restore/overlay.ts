import type { Img } from '../raster.ts'
import type { ElementKind, RestoreElement } from './schema.ts'
import { labelNumbers } from './label.ts'

/**
 * 给模型看的标注图：原画上画出每个元素的框和编号。没有字体可用，编号用 3×5 的点阵数字画，放大几倍贴在框的左上角
 */

const DIGITS = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
]

export const KIND_COLOR: Record<ElementKind, [number, number, number]> = {
  background: [148, 163, 184],
  panel: [167, 139, 250],
  button: [249, 115, 22],
  slot: [232, 121, 249],
  icon: [56, 189, 248],
  text: [74, 222, 128],
  bar: [251, 191, 36],
  input: [244, 63, 94],
  decoration: [250, 204, 21],
  other: [255, 255, 255],
}

function rect(img: Img, x: number, y: number, w: number, h: number, c: [number, number, number], fill = false, t = 2) {
  for (let j = Math.max(0, y); j < Math.min(img.height, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(img.width, x + w); i++) {
      if (!fill && i >= x + t && i < x + w - t && j >= y + t && j < y + h - t) continue
      const p = (j * img.width + i) * 4
      img.data[p] = c[0]
      img.data[p + 1] = c[1]
      img.data[p + 2] = c[2]
      img.data[p + 3] = 255
    }
}

function number(img: Img, n: number, x: number, y: number, s: number) {
  const str = String(n)
  rect(img, x, y, str.length * 4 * s + s, 7 * s, [255, 255, 255], true)
  ;[...str].forEach((ch, k) => {
    const bits = DIGITS[Number(ch)]
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++)
        if (bits[r * 3 + c] === '1') rect(img, x + s + k * 4 * s + c * s, y + s + r * s, s, s, [0, 0, 0], true)
  })
}

export function drawLabels(src: Img, elements: RestoreElement[]): Img {
  const img = { width: src.width, height: src.height, data: src.data.slice() }
  const nums = labelNumbers(elements)
  const s = Math.max(2, Math.round(Math.min(img.width, img.height) / 400))
  const t = Math.max(1, Math.round(s / 1.5))
  const live = elements.filter((e) => nums.has(e.id))
  for (const e of live)
    rect(
      img,
      Math.round(e.box.x),
      Math.round(e.box.y),
      Math.round(e.box.w),
      Math.round(e.box.h),
      KIND_COLOR[e.kind],
      false,
      t,
    )
  for (const e of live) number(img, nums.get(e.id)!, Math.round(e.box.x), Math.round(e.box.y), s)
  return img
}
