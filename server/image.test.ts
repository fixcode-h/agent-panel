/**
 * 图片处理测试：PNG 编解码、精确缩放、绿底抠图、图标表切图。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTENT_FILL,
  blank,
  chromaKey,
  contentBox,
  decodePng,
  encodePng,
  fitExact,
  gridStep,
  maskImage,
  normalizeGenerated,
  resize,
  sliceSheet,
} from './image.ts'

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

test('生成的图精确变成要的尺寸：透明图保持比例居中，不拉伸', () => {
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

const margins = (img: ReturnType<typeof blank>) => {
  const box = contentBox(img)!
  return { L: box.x, T: box.y, R: img.width - box.x - box.w, B: img.height - box.y - box.h, box }
}

test('透明图内容画偏了：裁到内容、等比居中，四边都留透明边距', () => {
  const g = blank(380, 270)
  fill(g, 0, 0, 264, 234, [200, 20, 20, 255])
  const m = margins(fitExact(g, 380, 270))
  assert.ok(m.L > 0 && m.T > 0, '贴左上的内容要移进来')
  assert.ok(Math.abs(m.L - m.R) <= 1 && Math.abs(m.T - m.B) <= 1, '左右、上下边距各自对称')
  assert.ok(m.box.w <= Math.ceil(380 * CONTENT_FILL) && m.box.h <= Math.ceil(270 * CONTENT_FILL))
  assert.ok(Math.abs(m.box.w / m.box.h / (264 / 234) - 1) < 0.02, '比例不变，不拉伸')
})

test('尺寸已经对、内容贴边的透明图，normalizeGenerated 也会重新摆到中间', () => {
  const g = blank(380, 270)
  fill(g, 0, 0, 264, 234, [200, 20, 20, 255])
  const out = normalizeGenerated(encodePng(g), { width: 380, height: 270, transparent: true })
  const m = margins(decodePng(out)!)
  assert.ok(m.L > 0 && m.T > 0 && m.R > 0 && m.B > 0)
  assert.ok(Math.abs(m.L - m.R) <= 1 && Math.abs(m.T - m.B) <= 1)
})

test('不透明图尺寸已经对时原样返回，不重新编码', () => {
  const buf = encodePng(blank(64, 64, [10, 20, 30, 255]))
  assert.equal(normalizeGenerated(buf, { width: 64, height: 64, transparent: false }), buf)
})

test('九宫格图走 stretch：直接缩放到目标尺寸，不裁内容', () => {
  const g = blank(200, 100)
  fill(g, 0, 0, 200, 100, [10, 20, 200, 255])
  const out = fitExact(g, 100, 50, { stretch: true })
  assert.deepEqual([out.width, out.height], [100, 50])
  assert.deepEqual([...out.data.subarray(0, 4)], [10, 20, 200, 255])
})

test('contentBox 的阈值：几乎透明的边缘不算内容', () => {
  const g = blank(40, 40)
  fill(g, 0, 0, 40, 40, [255, 255, 255, 8])
  fill(g, 10, 10, 20, 20, [255, 255, 255, 200])
  assert.deepEqual(contentBox(g), { x: 10, y: 10, w: 20, h: 20 })
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

const red = (img: ReturnType<typeof maskImage>, x: number, y: number) => img.data[(y * img.width + x) * 4]

test('局部重绘的蒙版图：黑底，涂过的地方是白色', () => {
  const img = maskImage([{ erase: false, w: 20, points: [50, 50] }], 100, 100)
  assert.deepEqual([img.width, img.height], [100, 100])
  assert.equal(red(img, 50, 50), 255)
  assert.equal(img.data[(50 * 100 + 50) * 4 + 3], 255)
  assert.equal(red(img, 5, 5), 0)
})

test('局部重绘的蒙版图：沿轨迹涂成一条连续的粗线', () => {
  const img = maskImage([{ erase: false, w: 10, points: [20, 50, 80, 50] }], 100, 100)
  assert.equal(red(img, 20, 50), 255)
  assert.equal(red(img, 50, 50), 255)
  assert.equal(red(img, 80, 50), 255)
  assert.equal(red(img, 50, 20), 0)
})

test('局部重绘的蒙版图：橡皮擦把涂过的区域擦回黑色', () => {
  const img = maskImage(
    [
      { erase: false, w: 40, points: [50, 50] },
      { erase: true, w: 20, points: [50, 50] },
    ],
    100,
    100,
  )
  assert.equal(red(img, 50, 50), 0)
  assert.equal(red(img, 50, 62), 255)
})

test('局部重绘的蒙版图：笔画超出画布时裁掉，不越界', () => {
  const img = maskImage([{ erase: false, w: 60, points: [-20, -20, 120, 120] }], 40, 40)
  assert.deepEqual([img.width, img.height], [40, 40])
  assert.equal(red(img, 0, 0), 255)
  assert.equal(red(img, 39, 39), 255)
})
