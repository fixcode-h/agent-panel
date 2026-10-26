import assert from 'node:assert/strict'
import test from 'node:test'
import { mossBbox, mossLayoutJson, designLayoutItems, type MossLayoutItem } from './moss.ts'
import type { Widget } from './umg.ts'

const slot = (x: number, y: number, w: number, h: number) => ({
  LayoutData: {
    Offsets: { Left: x, Top: y, Right: w, Bottom: h },
    Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 0, Y: 0 } },
    Alignment: { X: 0, Y: 0 },
  },
})

const widget = (Type: string, Name: string, extra: Partial<Widget> = {}): Widget => ({
  id: Name,
  Type: Type as Widget['Type'],
  Name,
  Properties: {},
  ...extra,
})

test('mossBbox：按出图尺寸缩放，再换成中心原点、yxyx，边缘向外取整', () => {
  // 1920×1080 的设计稿上 (96,54,192,108) 放到 1024×576 的图里
  const bbox = mossBbox({ x: 96, y: 54, w: 192, h: 108 }, { width: 1920, height: 1080 }, { width: 1024, height: 576 })
  assert.deepEqual(bbox, [-260, -461, -201, -358])
})

test('mossBbox：超出画布的部分裁掉，没有面积的框不要', () => {
  assert.deepEqual(
    mossBbox({ x: -100, y: -100, w: 200, h: 200 }, { width: 100, height: 100 }, { width: 100, height: 100 }),
    [-50, -50, 50, 50],
  )
  assert.equal(
    mossBbox({ x: 200, y: 200, w: 10, h: 10 }, { width: 100, height: 100 }, { width: 100, height: 100 }),
    undefined,
  )
  assert.equal(mossBbox({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 }), undefined)
})

const item = (over: Partial<MossLayoutItem> = {}): MossLayoutItem => ({
  label: 'text',
  caption: 'UI text label: 48px bold',
  text: '开始游戏',
  rect: { x: 0, y: 0, w: 100, h: 50 },
  ...over,
})

test('mossLayoutJson：单行 JSON，字段和官方 compile_prompt 一致', () => {
  const json = mossLayoutJson([item(), item({ label: 'object', caption: 'a red gem', text: undefined })], {
    source: { width: 1024, height: 1024 },
    size: { width: 1024, height: 1024 },
    caption: 'a game menu',
  })!
  assert.equal(json.includes('\n'), false)
  const o = JSON.parse(json)
  assert.equal(o.bbox_coord_space, 'abs_centralized')
  assert.equal(o.bbox_format, 'yxyx')
  assert.equal(o.summary.caption, 'a game menu')
  assert.equal(o.items.length, 2)
  assert.deepEqual(o.items[0], {
    label: 'text',
    caption: 'UI text label: 48px bold',
    text: '开始游戏',
    bbox: [-512, -512, -462, -412],
  })
  // object 不带 text
  assert.deepEqual(o.items[1], { label: 'object', caption: 'a red gem', bbox: [-512, -512, -462, -412] })
})

test('mossLayoutJson：没有有效项时返回 undefined，调用方回退成描述', () => {
  assert.equal(
    mossLayoutJson([], { source: { width: 100, height: 100 }, size: { width: 100, height: 100 } }),
    undefined,
  )
  assert.equal(
    mossLayoutJson([item({ rect: { x: 200, y: 200, w: 0, h: 0 } })], {
      source: { width: 100, height: 100 },
      size: { width: 100, height: 100 },
    }),
    undefined,
  )
})

test('designLayoutItems：CanvasPanel 里的文字按绝对位置取出来，默认文字跳过', () => {
  const root = widget('CanvasPanel', 'Root', {
    Children: [
      widget('TextBlock', 'Txt_Title', {
        Slot: slot(100, 200, 300, 80),
        Properties: { Text: '开始游戏', Font: { Size: 36, TypefaceFontName: 'Bold' } },
      }),
      widget('TextBlock', 'Txt_Empty', { Slot: slot(0, 0, 100, 30), Properties: { Text: 'Text Block' } }),
      widget('TextBlock', 'Txt_Blank', { Slot: slot(0, 40, 100, 30), Properties: { Text: '  ' } }),
    ],
  })
  const items = designLayoutItems(root, [], { X: 1920, Y: 1080 })
  assert.equal(items.length, 1)
  assert.equal(items[0].label, 'text')
  assert.equal(items[0].text, '开始游戏')
  assert.deepEqual(items[0].rect, { x: 100, y: 200, w: 300, h: 80 })
  // UMG 的 36 号字在屏幕上约 48px
  assert.match(items[0].caption, /48px/)
  assert.match(items[0].caption, /bold/)
})

test('designLayoutItems：嵌套的 CanvasPanel 逐层累加位置', () => {
  const root = widget('CanvasPanel', 'Root', {
    Children: [
      widget('CanvasPanel', 'Panel', {
        Slot: slot(100, 100, 800, 600),
        Children: [widget('TextBlock', 'Txt_In', { Slot: slot(10, 20, 200, 50), Properties: { Text: '金币' } })],
      }),
    ],
  })
  const items = designLayoutItems(root, [], { X: 1920, Y: 1080 })
  assert.deepEqual(items[0].rect, { x: 110, y: 120, w: 200, h: 50 })
})

test('designLayoutItems：用到了有描述图片的控件算 object，没描述的跳过', () => {
  const root = widget('CanvasPanel', 'Root', {
    Children: [
      widget('Image', 'Img_Gem', {
        Slot: slot(10, 10, 64, 64),
        Properties: { Brush: { ResourceObject: 'img:gem' } },
      }),
      widget('Image', 'Img_Plain', {
        Slot: slot(80, 10, 64, 64),
        Properties: { Brush: { ResourceObject: 'img:plain' } },
      }),
    ],
  })
  const items = designLayoutItems(
    root,
    [
      { id: 'gem', prompt: 'a glowing red gem icon' },
      { id: 'plain', prompt: '' },
    ],
    { X: 1920, Y: 1080 },
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].label, 'object')
  assert.equal(items[0].caption, 'a glowing red gem icon')
})

test('designLayoutItems：隐藏的控件和它里面的控件都不取', () => {
  const root = widget('CanvasPanel', 'Root', {
    Children: [
      widget('TextBlock', 'Txt_Hidden', {
        Slot: slot(0, 0, 100, 40),
        Properties: { Text: '关卡完成', Visibility: 'Collapsed' },
      }),
      widget('CanvasPanel', 'Panel_Hidden', {
        Slot: slot(0, 50, 400, 200),
        Properties: { Visibility: 'Hidden' },
        Children: [widget('TextBlock', 'Txt_In', { Slot: slot(10, 10, 100, 40), Properties: { Text: '不该出现' } })],
      }),
    ],
  })
  assert.deepEqual(designLayoutItems(root, [], { X: 1920, Y: 1080 }), [])
})

test('designLayoutItems：非 CanvasPanel 容器里的控件量不出位置，跳过；网页根节点返回空', () => {
  const box = widget('CanvasPanel', 'Root', {
    Children: [
      widget('VerticalBox', 'Box', {
        Slot: slot(0, 0, 400, 400),
        Children: [widget('TextBlock', 'Txt_In', { Properties: { Text: '按钮' } })],
      }),
    ],
  })
  assert.equal(designLayoutItems(box, [], { X: 1920, Y: 1080 }).length, 0)
  const web = widget('Frame', 'Page', {
    Children: [widget('Text', 'Title', { Properties: { Text: '标题', FontSize: 32 } })],
  })
  assert.equal(designLayoutItems(web, [], { X: 1920, Y: 1080 }).length, 0)
})

test('designLayoutItems：最多取 limit 项', () => {
  const children = Array.from({ length: 10 }, (_, i) =>
    widget('TextBlock', `Txt_${i}`, { Slot: slot(i * 10, 0, 100, 40), Properties: { Text: `文字 ${i}` } }),
  )
  const root = widget('CanvasPanel', 'Root', { Children: children })
  assert.equal(designLayoutItems(root, [], { X: 1920, Y: 1080 }, 3).length, 3)
})
