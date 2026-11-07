import assert from 'node:assert/strict'
import test from 'node:test'
import { blank, paste, type Img } from '../raster.ts'
import { detectElements } from './detect.ts'
import { compileRestore } from './compile.ts'
import { verifyRestore } from './verify.ts'
import { detectNineSlice, extractAssets, fillHoles } from './assets.ts'
import { applyLabels, labelNumbers } from './label.ts'
import { confirmStep, editElements, runStep, setSource, stateOf } from './steps.ts'
import { emptyRestore, stepOf, type RestoreElement } from './schema.ts'
import { DEFAULT_THRESHOLDS } from './thresholds.ts'
import type { Design } from '../design.ts'

/** 空心框：2 像素的描边，里面是另一个颜色 */
function frame(img: Img, x: number, y: number, w: number, h: number, edge: number[], fill: number[]) {
  paste(img, blank(w, h, edge as [number, number, number, number]), x, y)
  paste(img, blank(w - 4, h - 4, fill as [number, number, number, number]), x + 2, y + 2)
}

/** 一张假的背包原画：大面板、5×3 的格子（中间画一个图标）、一个按钮 */
function inventory(): Img {
  const img = blank(800, 450, [18, 12, 30, 255])
  frame(img, 100, 60, 600, 330, [200, 160, 60, 255], [40, 30, 60, 255])
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 5; c++) {
      frame(img, 130 + c * 66, 90 + r * 66, 56, 56, [120, 100, 170, 255], [16, 10, 26, 255])
      if ((r + c) % 2 === 0) paste(img, blank(24, 24, [80, 160, 240, 255]), 146 + c * 66, 106 + r * 66)
    }
  frame(img, 500, 320, 160, 44, [220, 180, 80, 255], [110, 50, 40, 255])
  return img
}

const near = (a: number, b: number, d = 3) => Math.abs(a - b) <= d

test('detectElements：量出面板、按钮和 5×3 的格子组（格子大小、间距按像素对上）', () => {
  const r = detectElements(inventory())
  const panel = r.elements.find((e) => e.kind === 'panel' && e.box.w > 500)
  assert.ok(panel, '大面板')
  assert.ok(near(panel.box.x, 100) && near(panel.box.y, 60) && near(panel.box.w, 600) && near(panel.box.h, 330))
  const btn = r.elements.find((e) => e.kind === 'button')
  assert.ok(btn && near(btn.box.x, 500) && near(btn.box.w, 160), '按钮')
  const g = r.groups.find((x) => x.rows === 3 && x.cols === 5)
  assert.ok(g, `格子组 ${JSON.stringify(r.groups)}`)
  assert.ok(near(g.cell.w, 56) && near(g.cell.h, 56), '格子大小')
  assert.ok(near(g.gap.x, 10) && near(g.gap.y, 10), '格子间距')
  // 格子里的图标单独是一个元素
  assert.ok(r.elements.filter((e) => e.kind === 'icon').length >= 6, '图标')
})

test('compileRestore + verifyRestore：按元素框编出锁住的控件，位置和元素一致', () => {
  const elements: RestoreElement[] = [
    {
      id: 'bg',
      kind: 'background',
      name: 'Bg_Main',
      box: { x: 0, y: 0, w: 800, h: 450 },
      confidence: 1,
      source: 'detect',
    },
    {
      id: 'p',
      kind: 'panel',
      name: 'Panel_Main',
      box: { x: 100, y: 60, w: 600, h: 330 },
      confidence: 1,
      source: 'detect',
    },
    {
      id: 'b',
      kind: 'button',
      name: 'Btn_Use',
      box: { x: 500, y: 320, w: 160, h: 44 },
      confidence: 1,
      source: 'detect',
    },
    {
      id: 't',
      kind: 'text',
      name: 'Txt_Use',
      box: { x: 550, y: 330, w: 60, h: 24 },
      confidence: 1,
      source: 'ai',
      text: { content: '使用', px: 20, color: '#FFFFFFFF', align: 'center', bold: false },
    },
  ]
  const restore = {
    ...emptyRestore(),
    source: { kind: 'image' as const, file: 'a.png', name: '', width: 800, height: 450 },
    elements,
  }
  const designSize = { X: 1600, Y: 900 }
  const c = compileRestore({ restore, designSize, images: { p: 'rs_p' } })
  const panel = c.root.Children!.find((w) => w.Name === 'Panel_Main')!
  assert.equal(panel.Properties.Locked, true, '位置锁住')
  assert.equal(panel.Children![0].Properties.Brush.ResourceObject, 'img:rs_p', '面板底图用切图')
  const btn = panel.Children!.find((w) => w.Name === 'Btn_Use')!
  assert.equal(btn.Type, 'Button')
  // 原画 → 设计稿放大一倍，相对父控件摆
  assert.deepEqual(btn.Slot!.LayoutData.Offsets, { Left: 800, Top: 520, Right: 320, Bottom: 88 })
  assert.equal(btn.Children![0].Children![0].Properties.Text, '使用', '按钮上的字在按钮里面')
  const s = verifyRestore({ restore, root: c.root, designSize, names: c.names, thresholds: DEFAULT_THRESHOLDS })
  assert.equal(s.posOk, s.posTotal, JSON.stringify(s.items.filter((i) => !i.ok)))
  assert.ok(s.passed)
  // 挪了控件：校验能指出来
  btn.Slot!.LayoutData.Offsets.Left += 12
  const bad = verifyRestore({ restore, root: c.root, designSize, names: c.names, thresholds: DEFAULT_THRESHOLDS })
  assert.equal(bad.items.find((i) => i.element === 'b')?.why, 'position')
})

test('extractAssets：容器擦掉子元素补底，一样的空格子共用一张，拼回去和原画很像', () => {
  const art = inventory()
  const r = detectElements(art)
  const x = extractAssets(art, r.elements)
  const sims = Object.values(x.sims)
  assert.ok(sims.reduce((s, v) => s + v, 0) / sims.length > 0.95, `平均相似度 ${sims}`)
  assert.ok(
    x.slices.some((s) => s.same),
    '有共用的切图',
  )
  // 干净背景上面板的位置补成了周围的底色
  const p = (380 * art.width + 400) * 4
  assert.ok(Math.abs(x.plate.data[p] - 18) < 12, `补底 ${x.plate.data[p]}`)
})

test('fillHoles / detectNineSlice：补洞取四周的颜色；中间一片平的框能九宫格拉伸', () => {
  const img = blank(40, 40, [100, 100, 100, 255])
  paste(img, blank(10, 10, [255, 0, 0, 255]), 15, 15)
  const out = fillHoles(img, [{ x: 15, y: 15, w: 10, h: 10 }])
  assert.equal(out.data[(20 * 40 + 20) * 4], 100)
  const f = blank(120, 80, [0, 0, 0, 255])
  frame(f, 0, 0, 120, 80, [200, 160, 60, 255], [40, 30, 60, 255])
  const nine = detectNineSlice(f)
  assert.ok(nine && nine.Left > 0 && nine.Left < 0.1, JSON.stringify(nine))
})

test('applyLabels：只收类型、名字、文字，不收坐标；用户改过的不动；名字补前缀、去重', () => {
  const list: RestoreElement[] = [
    { id: 'bg', kind: 'background', name: '', box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 1, source: 'detect' },
    { id: 'a', kind: 'icon', name: '', box: { x: 1, y: 1, w: 4, h: 2 }, confidence: 1, source: 'detect' },
    { id: 'b', kind: 'icon', name: 'Icon_Keep', box: { x: 5, y: 5, w: 2, h: 2 }, confidence: 1, source: 'user' },
    { id: 'c', kind: 'icon', name: '', box: { x: 7, y: 1, w: 2, h: 2 }, confidence: 1, source: 'detect' },
  ]
  const nums = labelNumbers(list)
  assert.equal(nums.get('a'), 1)
  const r = applyLabels(list, [], {
    elements: [
      { n: 1, kind: 'text', name: 'Title', text: '背包' },
      { n: 2, name: 'Changed' },
      { n: 3, drop: true },
    ],
    groups: [],
    missing: [],
    note: '',
  })
  const a = r.elements.find((e) => e.id === 'a')!
  assert.deepEqual([a.kind, a.name, a.text?.content, a.box.x], ['text', 'Txt_Title', '背包', 1])
  assert.equal(r.elements.find((e) => e.id === 'b')!.name, 'Icon_Keep')
  assert.equal(r.elements.find((e) => e.id === 'c')!.hidden, true)
})

test('六步流程：每步交一版等确认，确认了才跑下一步；改了元素后面的步骤标成要更新', async () => {
  const art = inventory()
  const d = {
    id: 'd1',
    designSize: { X: 1600, Y: 900 },
    images: [],
    components: [],
    root: { id: 'r', Type: 'CanvasPanel', Name: 'Root', Properties: {}, Children: [] },
    rev: 0,
  } as unknown as Design
  setSource(d, { kind: 'image', file: 'a.png', name: '', width: 800, height: 450 }, 'now')
  assert.equal(stepOf(d.restore, 'source').status, 'review')
  let stored = 0
  const ctx = {
    design: d,
    art: async () => art,
    store: async (img: Img) => ({ file: `f${++stored}.png`, width: img.width, height: img.height }),
    thresholds: DEFAULT_THRESHOLDS,
    now: () => 'now',
  }
  assert.equal(confirmStep(d, 'source'), 'elements')
  await runStep('elements', ctx)
  assert.equal(stepOf(d.restore, 'elements').status, 'review')
  assert.equal(stepOf(d.restore, 'elements').versions.length, 1)
  for (const [step, next] of [
    ['elements', 'assets'],
    ['assets', 'build'],
    ['build', 'verify'],
    ['verify', 'deliver'],
  ] as const) {
    if (step !== 'elements') await runStep(step, ctx)
    assert.equal(confirmStep(d, step), next)
  }
  assert.ok(d.images.length > 0 && d.images.every((i) => i.variants[0].source === 'crop'), '切图都是从原画抠的')
  assert.ok(stateOf(d).score?.passed, JSON.stringify(stateOf(d).score?.items.filter((i) => !i.ok)))
  // 结构推断：5×3 的格子抽成一个子控件，网格绑一份 15 行的数据；按钮四态都有图（派生的）
  assert.equal(d.components.length, 1, '格子抽成子控件')
  assert.equal(d.data?.sets[0]?.rows.length, 15)
  const grid = JSON.stringify(d.root)
  assert.ok(grid.includes('UniformGridPanel') && grid.includes(d.components[0].Name))
  assert.ok(['hover', 'pressed', 'disabled'].every((st) => d.images.some((i) => i.id.endsWith(`_${st}`))))
  // 交付：换成 21:9、16:10、4:3 排一遍，锚点推断对了就没有跑出画面、叠在一起的
  await runStep('deliver', ctx)
  const adapt = stepOf(d.restore, 'deliver').versions.at(-1)!.card
  assert.ok(adapt.metrics.length === 3 && adapt.metrics.every((m) => m.ok), JSON.stringify(adapt.warnings))
  // 重跑拆解：出第 2 版，带上和上一版的差别；改元素让后面做过的都标成要更新
  await runStep('elements', ctx, '标题漏了')
  assert.equal(stepOf(d.restore, 'elements').versions.at(-1)?.feedback, '标题漏了')
  editElements(d, stateOf(d).elements)
  assert.equal(stepOf(d.restore, 'assets').status, 'stale')
})
