import assert from 'node:assert/strict'
import test from 'node:test'
import { blank, paste, type Img } from '../raster.ts'
import type { Design } from '../design.ts'
import { walk } from '../umg.ts'
import { inferFlex } from './compile-web.ts'
import { flatStyle } from './css.ts'
import { stepOf } from './schema.ts'
import { confirmStep, runStep, setSource, stateOf } from './steps.ts'
import { DEFAULT_THRESHOLDS } from './thresholds.ts'

/** 纯色框带一圈描边 */
function frame(img: Img, x: number, y: number, w: number, h: number, edge: number[], fill: number[], bw = 2) {
  paste(img, blank(w, h, edge as [number, number, number, number]), x, y)
  paste(img, blank(w - bw * 2, h - bw * 2, fill as [number, number, number, number]), x + bw, y + bw)
}

/** 一张假的网页原画：浅底，三张等距的卡片排成一行（卡片里画一张插图）；按钮在中间那张卡片底部 */
function landing(): Img {
  const img = blank(800, 450, [245, 246, 250, 255])
  for (let c = 0; c < 3; c++) {
    frame(img, 60 + c * 240, 80, 200, 220, [210, 214, 224, 255], [255, 255, 255, 255])
    paste(img, blank(80, 60, [80 + c * 50, 120, 220, 255]), 120 + c * 240, 130)
  }
  frame(img, 320, 236, 160, 48, [30, 64, 175, 255], [37, 99, 235, 255])
  return img
}

test('inferFlex：等距的一行推成 row + gap + 内边距；间距不齐的推不出来', () => {
  const row = inferFlex(
    [
      { x: 20, y: 10, w: 50, h: 30 },
      { x: 80, y: 10, w: 50, h: 30 },
      { x: 140, y: 10, w: 50, h: 30 },
    ],
    300,
    60,
  )
  assert.equal(row?.dir, 'row')
  assert.equal(row?.gap, 10)
  assert.deepEqual(row?.pad, { l: 20, t: 10, r: 0, b: 0 })
  const col = inferFlex(
    [
      { x: 10, y: 0, w: 80, h: 20 },
      { x: 30, y: 30, w: 40, h: 20 },
    ],
    100,
    100,
  )
  assert.deepEqual([col?.dir, col?.align], ['column', 'center'])
  const bad = inferFlex(
    [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 30, w: 10, h: 10 },
      { x: 60, y: 5, w: 10, h: 10 },
    ],
    100,
    100,
  )
  assert.equal(bad, undefined)
})

test('flatStyle：纯色带描边的框量出底色、描边宽和颜色；有渐变的不算', () => {
  const img = blank(120, 48, [0, 0, 0, 0])
  frame(img, 0, 0, 120, 48, [30, 64, 175, 255], [37, 99, 235, 255])
  const s = flatStyle(img)
  assert.deepEqual([s?.bg, s?.borderWidth, s?.borderColor], ['#2563EBFF', 2, '#1E40AFFF'])
  const grad = blank(120, 48, [0, 0, 0, 255])
  for (let x = 0; x < 120; x++) paste(grad, blank(1, 48, [x * 2, 40, 90, 255]), x, 0)
  assert.equal(flatStyle(grad), undefined)
})

test('网页还原：六步跑完搭成 flex 的 Frame 树，纯色框写成 CSS，位置全部对上', async () => {
  const art = landing()
  const d = {
    id: 'w1',
    kind: 'web',
    designSize: { X: 1600, Y: 900 },
    images: [],
    components: [],
    root: { id: 'r', Type: 'Frame', Name: 'Page', Properties: {}, Children: [] },
    rev: 0,
  } as unknown as Design
  setSource(d, { kind: 'image', file: 'a.png', name: '', width: 800, height: 450 }, 'now')
  let stored = 0
  const ctx = {
    design: d,
    art: async () => art,
    store: async (img: Img) => ({ file: `f${++stored}.png`, width: img.width, height: img.height }),
    thresholds: DEFAULT_THRESHOLDS,
    now: () => 'now',
  }
  assert.equal(confirmStep(d, 'source'), 'elements')
  for (const step of ['elements', 'assets', 'build', 'verify'] as const) {
    await runStep(step, ctx)
    confirmStep(d, step)
  }
  assert.ok(stateOf(d).score?.passed, JSON.stringify(stateOf(d).score?.items.filter((i) => !i.ok)))
  const types = new Set<string>()
  let css = 0
  let flex = 0
  walk(d.root, (w) => {
    types.add(w.Type)
    if (w.Properties.Background) css++
    if (w.Properties.Direction && w.Children?.length && !w.Children.some((c) => c.Slot?.Position === 'absolute')) flex++
  })
  assert.ok(!types.has('CanvasPanel') && types.has('Frame'), [...types].join(','))
  assert.ok(css >= 3, `纯色框写成 CSS：${css}`)
  assert.ok(flex >= 1, '至少一个容器用 flex 排')
  const card = stepOf(d.restore, 'build').versions.at(-1)!.card
  assert.ok(
    card.metrics.some((m) => m.value.includes('/')),
    JSON.stringify(card.metrics),
  )
  // 网页不做宽高比检查（断点在画布里切），交付卡不报问题
  await runStep('deliver', ctx)
  assert.equal(stepOf(d.restore, 'deliver').versions.at(-1)!.card.warnings.length, 0)
})
