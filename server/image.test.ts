/**
 * 图片处理测试：PNG 编解码、精确缩放、绿底抠图、图标表切图。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blank, chromaKey, contentBox, decodePng, encodePng, fitExact, gridStep, resize, sliceSheet } from './image.ts'

const GREEN: [number, number, number, number] = [0, 255, 0, 255]
const fill = (img: ReturnType<typeof blank>, x0: number, y0: number, w: number, h: number, c: number[]) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(c, (y * img.width + x) * 4)
}

test('PNG 编码再解码，像素不变', () => {
  const g = blank(100, 100, GREEN)
  fill(g, 20, 30, 60, 30, [200, 20, 20, 255])
  const back = decodePng(encodePng(g))!
  assert.deepEqual([back.width, back.height], [100, 100])
  assert.deepEqual([...back.data], [...g.data])
})

test('纯绿底抠成透明，内容范围找得准；角上不是绿色的不抠', () => {
  const g = blank(100, 100, GREEN)
  fill(g, 20, 30, 60, 30, [200, 20, 20, 255])
  const k = chromaKey(g)
  assert.equal(k.data[3], 0)
  assert.deepEqual(contentBox(k), { x: 20, y: 30, w: 60, h: 30 })
  const white = blank(50, 50, [255, 255, 255, 255])
  assert.equal(chromaKey(white), white)
})

test('生成的图精确变成要的尺寸：比例接近拉伸，差得多保持比例居中', () => {
  const g = blank(100, 100, GREEN)
  fill(g, 20, 30, 60, 30, [200, 20, 20, 255])
  const k = chromaKey(g)
  const a = fitExact(k, 40, 20)
  assert.deepEqual([a.width, a.height], [40, 20])
  assert.deepEqual([...a.data.subarray((10 * 40 + 20) * 4, (10 * 40 + 20) * 4 + 4)], [200, 20, 20, 255])
  const b = fitExact(k, 50, 50)
  assert.deepEqual([b.width, b.height], [50, 50])
  assert.equal(b.data[3], 0, '多出来的部分是透明的')
  assert.deepEqual([resize(g, 7, 13).width, resize(g, 7, 13).height], [7, 13])
})

test('图标表按格切开，每个图标裁掉空白后放进各自的尺寸', () => {
  const sheet = blank(200, 100, GREEN)
  fill(sheet, 25, 30, 50, 40, [10, 10, 200, 255])
  fill(sheet, 125, 30, 50, 40, [230, 120, 10, 255])
  const want = { width: 32, height: 32, transparent: true }
  const parts = sliceSheet(encodePng(sheet), 2, 1, [want, want])
  assert.ok(parts.every((p) => p && decodePng(p)!.width === 32 && decodePng(p)!.height === 32))
  // 多出来的一格没有图标：切不出来
  const wide = blank(300, 100, GREEN)
  fill(wide, 25, 30, 50, 40, [10, 10, 200, 255])
  fill(wide, 125, 30, 50, 40, [230, 120, 10, 255])
  assert.equal(sliceSheet(encodePng(wide), 3, 1, [want, want, want])[2], null)
})

test('坐标格的格距取整齐的数', () => {
  assert.deepEqual([gridStep(1920), gridStep(1080), gridStep(300), gridStep(64)], [200, 200, 50, 10])
})
