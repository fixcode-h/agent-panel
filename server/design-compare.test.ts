import assert from 'node:assert/strict'
import test from 'node:test'
import { compareImages } from './design-compare.ts'
import type { Img } from './image.ts'

/** 黑底上画一个白色的块 */
function rect(w: number, h: number, r: { x: number; y: number; w: number; h: number }): Img {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const on = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
      data.set([on ? 255 : 0, on ? 255 : 0, on ? 255 : 0, 255], (y * w + x) * 4)
    }
  return { width: w, height: h, data }
}

const size = { X: 400, Y: 300 }

test('compareImages：一样的图相似度 100、没有偏移', () => {
  const a = rect(400, 300, { x: 100, y: 100, w: 120, h: 60 })
  const r = compareImages(a, a, size)
  assert.equal(r.score, 100)
  assert.deepEqual([r.dx, r.dy], [0, 0])
})

test('compareImages：截图里的块偏了，报出往哪边挪多少像素能对齐，挪过以后相似度更高', () => {
  const tpl = rect(400, 300, { x: 100, y: 100, w: 120, h: 60 })
  const shot = rect(400, 300, { x: 110, y: 94, w: 120, h: 60 })
  const r = compareImages(shot, tpl, size)
  // 截图里的块在右边 10、上面 6：要往左挪 10、往下挪 6
  assert.ok(Math.abs(r.dx + 10) <= 2, `dx=${r.dx}`)
  assert.ok(Math.abs(r.dy - 6) <= 2, `dy=${r.dy}`)
  assert.ok(r.score < 100)
  assert.ok(r.aligned > r.score)
  // 模板分辨率和设计稿不同（缩放过的效果图）也按设计稿坐标算
  const big = rect(800, 600, { x: 200, y: 200, w: 240, h: 120 })
  const r2 = compareImages(shot, big, size, { x: 50, y: 50, w: 250, h: 150 })
  assert.ok(Math.abs(r2.dx + 10) <= 2 && Math.abs(r2.dy - 6) <= 2, `${r2.dx},${r2.dy}`)
})
