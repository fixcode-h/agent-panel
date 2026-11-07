import assert from 'node:assert/strict'
import test from 'node:test'
import { blank, paste, type Img } from '../raster.ts'
import { similarity } from './similarity.ts'

/** 一块 w×h 的图，中间画一个实心方块 */
function square(w: number, h: number, color: [number, number, number, number], at = 0.25): Img {
  const img = blank(w, h, [20, 20, 30, 255])
  paste(img, blank(Math.round(w * 0.5), Math.round(h * 0.5), color), Math.round(w * at), Math.round(h * at))
  return img
}

test('similarity：同一张图是 1，缩放过的仍然很像，换了颜色或位置明显变低', () => {
  const a = square(80, 80, [220, 180, 40, 255])
  assert.equal(Math.round(similarity(a, a) * 1000) / 1000, 1)
  // 原画抠出来再放大到显示尺寸：仍然很像
  const big = square(160, 160, [220, 180, 40, 255])
  assert.ok(similarity(a, big) > 0.95, `缩放 ${similarity(a, big)}`)
  // 颜色不同：形状一样也不能算像
  const blue = square(80, 80, [40, 90, 220, 255])
  assert.ok(similarity(a, blue) < 0.9, `换色 ${similarity(a, blue)}`)
  // 位置偏了：结构不像
  const moved = square(80, 80, [220, 180, 40, 255], 0.05)
  assert.ok(similarity(a, moved) < 0.8, `挪位 ${similarity(a, moved)}`)
})

test('similarity：透明和黑底不算一样', () => {
  const clear = blank(40, 40)
  const black = blank(40, 40, [0, 0, 0, 255])
  assert.ok(similarity(clear, black) < 0.8)
})
