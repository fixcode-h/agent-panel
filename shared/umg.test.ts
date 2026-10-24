/**
 * 九宫格参数测试：图片的 nineSlice 统一成比例，画刷的 Margin / ImageSize 跟着图片走。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_WIDGET_SIZE,
  WIDGETS,
  assignImage,
  brush,
  canvasSlotRect,
  clampWidgetSize,
  defaultSlot,
  exportWidget,
  imageFitStyle,
  nineSliceRatios,
  normalizeTree,
  rectToCanvasSlot,
  resizeCanvasSlot,
  syncBrushSlices,
  type Brush,
  type Widget,
} from './umg.ts'

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

test('clampWidgetSize：宽高不小于最小尺寸，非法值也按最小尺寸算', () => {
  assert.equal(MIN_WIDGET_SIZE, 8)
  assert.equal(clampWidgetSize(0), MIN_WIDGET_SIZE)
  assert.equal(clampWidgetSize(-30), MIN_WIDGET_SIZE)
  assert.equal(clampWidgetSize(12.4), 12)
  assert.equal(clampWidgetSize(Number.NaN), MIN_WIDGET_SIZE)
})

test('resizeCanvasSlot：非拉伸缩到最小尺寸后停住，不会出现负宽高或翻转', () => {
  const slot = defaultSlot('CanvasPanelSlot', 10, 20, 100, 50)!
  const out = resizeCanvasSlot(slot, -500, -500)
  assert.equal(out.LayoutData.Offsets.Right, MIN_WIDGET_SIZE)
  assert.equal(out.LayoutData.Offsets.Bottom, MIN_WIDGET_SIZE)
  assert.equal(out.LayoutData.Offsets.Left, 10)
  assert.equal(out.LayoutData.Offsets.Top, 20)
  // 再从最小尺寸往大拖，能正常变大
  const grow = resizeCanvasSlot(out, 12, 6)
  assert.equal(grow.LayoutData.Offsets.Right, MIN_WIDGET_SIZE + 12)
  assert.equal(grow.LayoutData.Offsets.Bottom, MIN_WIDGET_SIZE + 6)
})

test('resizeCanvasSlot：对齐点不是左上时按实际变化的宽高补偿位置', () => {
  const slot = defaultSlot('CanvasPanelSlot', 40, 40, 100, 100)!
  slot.LayoutData.Alignment = { X: 0.5, Y: 0.5 }
  const out = resizeCanvasSlot(slot, 20, 20)
  assert.equal(out.LayoutData.Offsets.Right, 120)
  assert.equal(out.LayoutData.Offsets.Left, 50)
  assert.equal(out.LayoutData.Offsets.Bottom, 120)
  assert.equal(out.LayoutData.Offsets.Top, 50)
})

test('canvasSlotRect：非拉伸按锚点、偏移和对齐点算位置，拉伸按两个锚点算宽高', () => {
  const slot = defaultSlot('CanvasPanelSlot', 10, 20, 100, 50)!
  assert.deepEqual(canvasSlotRect(slot, { w: 800, h: 600 }), { x: 10, y: 20, w: 100, h: 50 })

  // 对齐点 0.5：控件从锚点往左 / 上挪半个宽高
  slot.LayoutData.Alignment = { X: 0.5, Y: 0.5 }
  slot.LayoutData.Anchors = { Minimum: { X: 0.5, Y: 0.5 }, Maximum: { X: 0.5, Y: 0.5 } }
  // 锚点 0.5 在父控件中间（400 / 300），再加偏移，最后按对齐点挪半个宽高
  assert.deepEqual(canvasSlotRect(slot, { w: 800, h: 600 }), { x: 360, y: 295, w: 100, h: 50 })

  // 拉伸：左右边距到父控件两边的距离
  const stretch = defaultSlot('CanvasPanelSlot', 10, 10, 0, 0)!
  stretch.LayoutData.Anchors = { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } }
  stretch.LayoutData.Offsets = { Left: 10, Top: 10, Right: 10, Bottom: 10 }
  assert.deepEqual(canvasSlotRect(stretch, { w: 800, h: 600 }), { x: 10, y: 10, w: 780, h: 580 })

  // 锚点下界不是 0：宽度是两个锚点之间的跨度（半屏拉伸），不是整个父控件
  const half = defaultSlot('CanvasPanelSlot', 0, 0, 0, 0)!
  half.LayoutData.Anchors = { Minimum: { X: 0.5, Y: 0.5 }, Maximum: { X: 1, Y: 1 } }
  half.LayoutData.Offsets = { Left: 0, Top: 0, Right: 0, Bottom: 0 }
  assert.deepEqual(canvasSlotRect(half, { w: 800, h: 600 }), { x: 400, y: 300, w: 400, h: 300 })
  half.LayoutData.Offsets = { Left: 10, Top: 20, Right: 30, Bottom: 40 }
  assert.deepEqual(canvasSlotRect(half, { w: 800, h: 600 }), { x: 410, y: 320, w: 360, h: 240 })

  // 没有 LayoutData 的插槽按左上角、最小尺寸
  assert.deepEqual(canvasSlotRect(undefined, { w: 800, h: 600 }), {
    x: 0,
    y: 0,
    w: MIN_WIDGET_SIZE,
    h: MIN_WIDGET_SIZE,
  })
})

test('rectToCanvasSlot：锚点归零、对齐点左上，矩形原样写回并夹到最小尺寸', () => {
  const slot = defaultSlot('CanvasPanelSlot', 10, 20, 100, 50)!
  slot.LayoutData.Anchors = { Minimum: { X: 0.5, Y: 0.5 }, Maximum: { X: 1, Y: 1 } }
  slot.LayoutData.Alignment = { X: 0.5, Y: 0.5 }
  slot.bAutoSize = true
  const out = rectToCanvasSlot(slot, { x: 12.4, y: 30.6, w: 120, h: 40 })
  assert.deepEqual(out.LayoutData.Anchors, { Minimum: { X: 0, Y: 0 }, Maximum: { X: 0, Y: 0 } })
  assert.deepEqual(out.LayoutData.Alignment, { X: 0, Y: 0 })
  assert.deepEqual(out.LayoutData.Offsets, { Left: 12, Top: 31, Right: 120, Bottom: 40 })
  // 对齐后按矩形显示，不再由内容决定
  assert.equal(out.bAutoSize, false)
  assert.equal(out.ZOrder, slot.ZOrder)

  // 写回后换算出来还是同一个矩形
  assert.deepEqual(canvasSlotRect(out, { w: 800, h: 600 }), { x: 12, y: 31, w: 120, h: 40 })

  const tiny = rectToCanvasSlot(slot, { x: 0, y: 0, w: 0, h: -10 })
  assert.equal(tiny.LayoutData.Offsets.Right, MIN_WIDGET_SIZE)
  assert.equal(tiny.LayoutData.Offsets.Bottom, MIN_WIDGET_SIZE)
})

test('imageFitStyle：Fill 和旧数据一样拉伸，Contain / Cover 保持比例，Original 用图片原尺寸', () => {
  const img = { width: 64, height: 32 }
  // 不写 ImageFit 的旧数据必须是 100% × 100%
  assert.deepEqual(imageFitStyle(undefined, img), { size: '100% 100%', position: '0 0' })
  assert.deepEqual(imageFitStyle('Fill', img), { size: '100% 100%', position: '0 0' })
  assert.deepEqual(imageFitStyle('Contain', img), { size: 'contain', position: 'center' })
  assert.deepEqual(imageFitStyle('Cover', img), { size: 'cover', position: 'center' })
  assert.deepEqual(imageFitStyle('Original', img), { size: '64px 32px', position: 'left top' })
})

test('exportWidget：ImageFit 是面板内部属性，不进导出结果，画刷其他字段照常导出', () => {
  const image: Widget = {
    id: 'img1',
    Type: 'Image',
    Name: 'Icon',
    Properties: {
      Brush: brush({ ResourceObject: 'img:icon', ImageFit: 'Contain' }),
      ColorAndOpacity: '#FFFFFFFF',
      Locked: false,
    },
  }
  const tex = new Map([['icon', 'T_Icon']])
  const out = exportWidget(image, tex)
  assert.equal(out.Properties.Brush.ResourceObject, 'T_Icon')
  assert.equal('ImageFit' in out.Properties.Brush, false)
  assert.equal('Locked' in out.Properties, false)
})

test('exportWidget：Button 四种状态里嵌套的画刷也去掉 ImageFit', () => {
  const button: Widget = {
    id: 'b1',
    Type: 'Button',
    Name: 'Btn',
    Properties: {
      WidgetStyle: {
        Normal: brush({ ResourceObject: 'img:btn', ImageFit: 'Cover' }),
        Hovered: brush({ ImageFit: 'Contain' }),
      },
    },
  }
  const out = exportWidget(button, new Map([['btn', 'T_Btn']]))
  assert.equal('ImageFit' in out.Properties.WidgetStyle.Normal, false)
  assert.equal('ImageFit' in out.Properties.WidgetStyle.Hovered, false)
  assert.equal(out.Properties.WidgetStyle.Normal.ResourceObject, 'T_Btn')
})

test('新建控件：文字默认换行、CanvasPanelSlot 默认不按内容撑开', () => {
  assert.equal(WIDGETS.TextBlock.defaults().AutoWrapText, true)
  assert.equal(defaultSlot('CanvasPanelSlot')!.bAutoSize, false)
})

test('normalizeTree：存量 TextBlock 已经存下的 AutoWrapText 保持原样，不被新默认值改掉', () => {
  const old = normalizeTree({ Type: 'TextBlock', Name: 'Old', Properties: { AutoWrapText: false } })
  assert.equal(old.Properties.AutoWrapText, false)
  // 新数据按默认值换行
  const fresh = normalizeTree({ Type: 'TextBlock', Name: 'Fresh' })
  assert.equal(fresh.Properties.AutoWrapText, true)
})

test('resizeCanvasSlot：拉伸时按父控件尺寸夹紧边距', () => {
  const slot = defaultSlot('CanvasPanelSlot', 10, 10, 80, 80)!
  slot.LayoutData.Anchors = { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } }
  slot.LayoutData.Offsets = { Left: 10, Top: 10, Right: 10, Bottom: 10 }
  const out = resizeCanvasSlot(slot, -500, -500, { w: 120, h: 90 })
  assert.equal(out.LayoutData.Offsets.Right, 120 - 10 - MIN_WIDGET_SIZE)
  assert.equal(out.LayoutData.Offsets.Bottom, 90 - 10 - MIN_WIDGET_SIZE)
  // 左、上边距不受影响
  assert.equal(out.LayoutData.Offsets.Left, 10)
  assert.equal(out.LayoutData.Offsets.Top, 10)
})
