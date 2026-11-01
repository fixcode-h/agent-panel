import assert from 'node:assert/strict'
import test from 'node:test'
import { layoutChanges, layoutTree, measureText, rectLine, type LayoutRect } from './umg-layout.ts'
import { box, canvas, layoutFixtures, w } from './umg-layout.fixtures.ts'

/** 按名字取一个控件算出来的位置，四舍五入到 0.1 像素方便比对 */
function rects(name: string) {
  const f = layoutFixtures().find((x) => x.name === name)!
  const out = layoutTree(f.root, { size: f.size, components: f.components ?? [] })!
  const by = new Map(out.map((r) => [r.name, r]))
  return (n: string) => {
    const r = by.get(n)
    assert.ok(r, `没有算出 ${n}`)
    const k = (v: number) => Math.round(v * 10) / 10
    return [k(r.x), k(r.y), k(r.w), k(r.h)]
  }
}

// 下面的期望值都和画布组件在浏览器里量出来的一致（scripts/ui/11-umg-layout.mjs 每次推送都会对照）

test('画布：锚点、对齐点、拉伸和隐藏', () => {
  const at = rects('画布锚点')
  assert.deepEqual(at('TopLeft'), [40, 32, 320, 72])
  assert.deepEqual(at('Center'), [760, 440, 400, 200])
  assert.deepEqual(at('BottomRight'), [1796, 1006, 100, 50])
  assert.deepEqual(at('Stretch'), [10, 20, 1880, 1020])
  assert.deepEqual(at('StretchX'), [100, 900, 1720, 60])
  // Hidden 占位置、能量到；Collapsed 不画也不占位置
  assert.deepEqual(at('Hidden'), [5, 5, 10, 10])
  const f = layoutFixtures()[0]
  assert.ok(!layoutTree(f.root, { size: f.size, components: [] })!.some((r) => r.name === 'Gone'))
})

test('横竖排：Auto 按内容、Fill 扣掉插槽内边距后按比例分，Fill 对齐的图片保持 ImageSize', () => {
  const at = rects('横竖排')
  assert.deepEqual(at('Icon'), [8, 26, 64, 48])
  assert.deepEqual(at('A'), [80, 0, 220.7, 100])
  assert.deepEqual(at('B'), [304.7, 0, 441.3, 100])
  assert.deepEqual(at('Right'), [770, 70, 30, 30])
  assert.deepEqual(at('Banner'), [50, 130, 200, 60])
  assert.deepEqual(at('Btn'), [236, 200, 64, 32])
  assert.deepEqual(at('Fixed'), [0, 232, 120, 80])
  assert.deepEqual(at('Rest'), [0, 312, 300, 288])
  assert.deepEqual(at('Badge'), [668, 208, 24, 24])
  assert.deepEqual(at('Mid'), [525, 285, 50, 30])
})

test('变换、网格、换行、滚动、自动大小的子控件', () => {
  const at = rects('变换和其他控件')
  // 缩放绕中心、再平移：外框是变换后的包围盒，子控件跟着父控件一起变
  assert.deepEqual(at('Moved'), [80, 115, 300, 50])
  assert.deepEqual(at('Inner'), [80, 115, 75, 20])
  assert.deepEqual(at('Rotated'), [394.2, 78.3, 111.6, 93.3])
  assert.deepEqual(at('Card1'), [600, 50, 120, 90])
  assert.deepEqual(at('G11'), [265, 440, 20, 20])
  assert.deepEqual(at('W4'), [400, 346, 70, 40])
  assert.deepEqual(at('S3'), [760, 420, 80, 60])
  assert.deepEqual(at('Bar'), [50, 600, 200, 16])
  assert.deepEqual(at('Vol'), [300, 600, 160, 16])
})

test('列表、网格条目和切换器', () => {
  const at = rects('列表和切换')
  assert.deepEqual(at('Bag'), [20, 20, 312, 312])
  assert.deepEqual(at('Rows'), [400, 20, 300, 156])
  assert.deepEqual(at('Tab1'), [150, 455, 40, 40])
  assert.deepEqual(at('Clamp'), [400, 400, 150, 30])
  assert.deepEqual(at('Cell2'), [704, 400, 96, 96])
})

test('文字靠估算：标 est，被它推着走的控件也标', () => {
  const f = layoutFixtures().find((x) => x.name === '文字')!
  const out = layoutTree(f.root, { size: f.size, components: [] })!
  const by = new Map(out.map((r) => [r.name, r]))
  assert.equal(by.get('Title')!.est, true)
  // 固定尺寸的文字框位置大小都是准的
  assert.equal(by.get('Fixed')!.est, undefined)
  assert.deepEqual([by.get('Fixed')!.w, by.get('Fixed')!.h], [300, 40])
  // 在竖排里排在文字后面：位置跟着估
  assert.equal(by.get('After')!.est, true)
  // 换行：200 宽放不下一行，按两行算高度（12 号字 = 16px，行高 1.2）
  assert.equal(by.get('Long')!.h, 16 * 1.2 * 2)
  assert.match(rectLine(by.get('Title')!), /^Title（TextBlock）≈20,20 /)
})

test('measureText：中文按 1em、英文按词折行', () => {
  assert.equal(measureText('背包', { px: 20 }).w, 40)
  const m = measureText('hello world again', { px: 10, wrap: true, width: 40 })
  assert.equal(m.lines, 3)
  assert.equal(measureText('a\nb', { px: 10 }).lines, 2)
})

test('网页设计不算（交给浏览器截图）', () => {
  const root = w('Frame', 'Page', { Children: [w('Text', 'T', { Text: 'x' })] })
  assert.equal(layoutTree(root, { size: { X: 100, Y: 100 }, components: [] }), undefined)
})

test('layoutChanges：只列新出现和位置大小变了的控件', () => {
  const r = (name: string, x: number): LayoutRect => ({ name, type: 'Image', x, y: 0, w: 10, h: 10 })
  assert.deepEqual(
    layoutChanges([r('A', 0), r('B', 0)], [r('A', 0), r('B', 5), r('C', 1)]).map((x) => x.name),
    ['B', 'C'],
  )
})

test('横排里 flex-grow 合计不到 1 时只分走对应比例的剩余空间', () => {
  const root = w('CanvasPanel', 'R', {
    Children: [
      w('HorizontalBox', 'Row', {
        Slot: canvas(0, 0, 100, 10),
        Children: [w('Border', 'Half', { Slot: box({ fill: 0.5 }) })],
      }),
    ],
  })
  const out = layoutTree(root, { size: { X: 100, Y: 10 }, components: [] })!
  assert.equal(out.find((x) => x.name === 'Half')!.w, 50)
})

test('ScaleBox 按比例缩放子控件；自动换行的文字按插槽宽度折行', () => {
  const at = rects('缩放和换行')
  // 100×50 放进 400×400 的 ScaleToFit：放大 4 倍成 400×200，上下居中
  assert.deepEqual(at('FitImg'), [20, 120, 400, 200])
  // DownOnly 只缩小不放大：保持 100×50 居中
  assert.deepEqual(at('DownImg'), [600, 195, 100, 50])
  // Fill：两个方向各自拉伸
  assert.deepEqual(at('StretchImg'), [20, 440, 200, 100])
  // 左对齐的长文字在 200 宽的竖排里折成两行，后面的控件跟着往下排
  assert.deepEqual(at('Wrapped').slice(2), [200, 38.4])
  assert.equal(at('Below')[1], 478.4)
})
