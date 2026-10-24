/**
 * 九宫格参数测试：图片的 nineSlice 统一成比例，画刷的 Margin / ImageSize 跟着图片走。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignImage, brush, nineSliceRatios, syncBrushSlices, type Brush, type Widget } from './umg.ts'

const border = (b: Brush): Widget => ({
  id: 'w1',
  Type: 'Border',
  Name: 'Panel',
  Properties: { Background: b },
})

test('nineSliceRatios：比例原样保留，像素按图片宽高换算，限制在 0~0.49', () => {
  assert.deepEqual(nineSliceRatios({ Left: 0.1, Top: 0.2, Right: 0.3, Bottom: 0.1 }, 990, 936), {
    Left: 0.1,
    Top: 0.2,
    Right: 0.3,
    Bottom: 0.1,
  })
  const px = nineSliceRatios({ Left: 140, Top: 120, Right: 100, Bottom: 90 }, 990, 936)!
  assert.ok(Math.abs(px.Left - 140 / 990) < 1e-9)
  assert.ok(Math.abs(px.Top - 120 / 936) < 1e-9)
  assert.ok(Math.abs(px.Right - 100 / 990) < 1e-9)
  assert.ok(Math.abs(px.Bottom - 90 / 936) < 1e-9)
  assert.deepEqual(nineSliceRatios({ Left: 900, Top: 900, Right: 900, Bottom: 900 }, 990, 936), {
    Left: 0.49,
    Top: 0.49,
    Right: 0.49,
    Bottom: 0.49,
  })
  assert.equal(nineSliceRatios(undefined, 990, 936), undefined)
})

test('syncBrushSlices：Box 画刷用图片的比例和实际尺寸，其他画刷不动', () => {
  const slice = { Left: 140 / 990, Top: 120 / 936, Right: 100 / 990, Bottom: 90 / 936 }
  const imgs = new Map([['frame', { id: 'frame', width: 990, height: 936, transparent: true, nineSlice: slice }]])
  const wrong: Brush = {
    ResourceObject: 'img:frame',
    DrawAs: 'Box',
    ImageSize: { X: 32, Y: 32 },
    Margin: { Left: 0.11, Top: 0.1, Right: 0.045, Bottom: 0.065 },
    Tiling: 'NoTile',
    TintColor: '#FFFFFFFF',
  }
  const out = syncBrushSlices(border(wrong), imgs)
  const b = out.Properties.Background as any
  assert.deepEqual(b.Margin, slice)
  assert.deepEqual(b.ImageSize, { X: 990, Y: 936 })

  // Image 类型（不拉伸）不改
  const image = border({ ...wrong, DrawAs: 'Image' })
  assert.equal(syncBrushSlices(image, imgs), image)
  // 没有九宫格的图片不改
  const plain = new Map([['x', { id: 'x', width: 10, height: 10, transparent: false }]])
  const untouched = border(wrong)
  assert.equal(syncBrushSlices(untouched, plain), untouched)
  // 不透明的九宫格图不改：边距里可能是图片自己的底色，放大出来会露白
  const opaque = new Map([['frame', { id: 'frame', width: 990, height: 936, transparent: false, nineSlice: slice }]])
  const keep = border(wrong)
  assert.equal(syncBrushSlices(keep, opaque), keep)
})

test('syncBrushSlices：子控件里的画刷也一起修正', () => {
  const slice = { Left: 0.1, Top: 0.1, Right: 0.1, Bottom: 0.1 }
  const imgs = new Map([['frame', { id: 'frame', width: 100, height: 100, transparent: true, nineSlice: slice }]])
  const child: Widget = {
    id: 'c1',
    Type: 'Image',
    Name: 'Child',
    Properties: {
      Brush: {
        ResourceObject: 'img:frame',
        DrawAs: 'Border',
        ImageSize: { X: 32, Y: 32 },
        Margin: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
      },
    },
  }
  const root: Widget = { id: 'root', Type: 'Overlay', Name: 'Root', Properties: {}, Children: [child] }
  const out = syncBrushSlices(root, imgs)
  const b = out.Children![0].Properties.Brush as any
  assert.deepEqual(b.Margin, slice)
  assert.deepEqual(b.ImageSize, { X: 100, Y: 100 })
})

test('assignImage：像素形式的 nineSlice 也换算成比例，ImageSize 用图片实际尺寸', () => {
  const w = assignImage(border(brush()), {
    id: 'frame',
    width: 990,
    height: 936,
    nineSlice: { Left: 140, Top: 120, Right: 100, Bottom: 90 },
  })
  const b = w.Properties.Background as any
  assert.equal(b.DrawAs, 'Box')
  assert.deepEqual(b.ImageSize, { X: 990, Y: 936 })
  assert.ok(Math.abs(b.Margin.Left - 140 / 990) < 1e-9)
  assert.ok(Math.abs(b.Margin.Bottom - 90 / 936) < 1e-9)
})

test('assignImage：没有九宫格的图不写 Margin', () => {
  const w = assignImage(border(brush()), { id: 'icon', width: 96, height: 96 })
  const b = w.Properties.Background as any
  assert.equal(b.DrawAs, 'Image')
  assert.deepEqual([b.Margin.Left, b.Margin.Top, b.Margin.Right, b.Margin.Bottom], [0, 0, 0, 0])
  assert.deepEqual(b.ImageSize, { X: 96, Y: 96 })
})
