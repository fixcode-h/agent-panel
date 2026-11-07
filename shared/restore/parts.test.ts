import assert from 'node:assert/strict'
import test from 'node:test'
import { blank, paste, type Img } from '../raster.ts'
import { matchParts, partsPrompt, splitParts } from './parts.ts'
import { stepOf, type RestoreElement } from './schema.ts'
import { confirmStep, runStep, setSource, stateOf } from './steps.ts'
import { DEFAULT_THRESHOLDS } from './thresholds.ts'
import type { Design } from '../design.ts'

type C = [number, number, number, number]
function frame(img: Img, x: number, y: number, w: number, h: number, edge: C, fill: C) {
  paste(img, blank(w, h, edge), x, y)
  paste(img, blank(w - 4, h - 4, fill), x + 2, y + 2)
}
const GOLD: C = [200, 160, 60, 255]
const PANEL: C = [40, 30, 60, 255]
const SLOT_EDGE: C = [120, 100, 170, 255]
const SLOT: C = [16, 10, 26, 255]
const GEM: C = [80, 160, 240, 255]
const POTION: C = [220, 70, 90, 255]

/** 原画：面板里两个格子，格子里各有一个图标（一蓝一红），面板下面一个按钮 */
function screen(): Img {
  const img = blank(400, 260, [18, 12, 30, 255])
  frame(img, 40, 30, 320, 160, GOLD, PANEL)
  frame(img, 70, 60, 80, 80, SLOT_EDGE, SLOT)
  frame(img, 180, 60, 80, 80, SLOT_EDGE, SLOT)
  paste(img, blank(40, 40, GEM), 90, 80)
  paste(img, blank(40, 40, POTION), 200, 80)
  frame(img, 140, 205, 120, 40, GOLD, [110, 50, 40, 255])
  return img
}

/** 模型出的拆件图：透明底上各件分开画，大小和原画不一样（模型按自己的比例画），格子只画一次；退回绿底时传 green */
function sheet(green = false): Img {
  const img = blank(600, 400, green ? [0, 255, 0, 255] : [0, 0, 0, 0])
  frame(img, 20, 20, 384, 192, GOLD, PANEL)
  frame(img, 440, 20, 100, 100, SLOT_EDGE, SLOT)
  paste(img, blank(50, 50, GEM), 440, 160)
  paste(img, blank(50, 50, POTION), 520, 160)
  frame(img, 20, 260, 150, 50, GOLD, [110, 50, 40, 255])
  return img
}

const el = (id: string, kind: RestoreElement['kind'], x: number, y: number, w: number, h: number): RestoreElement => ({
  id,
  kind,
  name: id,
  box: { x, y, w, h },
  confidence: 1,
  source: 'detect',
})

test('splitParts：透明底上的每一件切开，框量准；模型退回绿底时去色键后切出一样的件', () => {
  const parts = splitParts(sheet())
  assert.equal(parts.length, 5)
  const green = splitParts(sheet(true))
  assert.deepEqual(
    green.map((p) => p.box),
    parts.map((p) => p.box),
  )
  assert.equal(green[0].img.data[(2 * green[0].img.width + 200) * 4 + 3], 255)
  const panel = parts.find((p) => p.box.w === 384)!
  assert.deepEqual(panel.box, { x: 20, y: 20, w: 384, h: 192 })
  assert.equal(panel.img.data[3], 255)
  const gem = parts.find((p) => p.box.x === 440 && p.box.y === 160)!
  assert.equal(gem.box.w, 50)
})

test('matchParts：元素按形状和颜色对上拆件图，重复的格子共用一件，面板用的是空的那件', () => {
  const art = screen()
  const elements = [
    el('bg', 'background', 0, 0, 400, 260),
    el('panel', 'panel', 40, 30, 320, 160),
    el('s1', 'slot', 70, 60, 80, 80),
    el('s2', 'slot', 180, 60, 80, 80),
    el('gem', 'icon', 90, 80, 40, 40),
    el('potion', 'icon', 200, 80, 40, 40),
    el('btn', 'button', 140, 205, 120, 40),
  ]
  const parts = splitParts(sheet())
  const m = matchParts(art, elements, parts)
  const boxOf = (id: string) => parts[m.get(id)!.part].box
  assert.equal(boxOf('panel').w, 384)
  assert.equal(m.get('s1')!.part, m.get('s2')!.part)
  assert.deepEqual([boxOf('gem').x, boxOf('potion').x], [440, 520])
  assert.equal(boxOf('btn').w, 150)
  // 面板这件是空的：格子的位置是面板自己的底色，不夹带格子
  const p = m.get('panel')!.img
  assert.equal(p.width, 320)
  const o = (60 * 320 + 60) * 4
  assert.deepEqual([...p.data.slice(o, o + 3)], PANEL.slice(0, 3))
  assert.ok(!m.has('bg'))
  assert.match(partsPrompt('game', elements, { width: 400, height: 260 }), /TRANSPARENT[\s\S]*slot/)
})

test('切图那一步：先出拆件图、存下来，对上的元素用拆件，出图失败写在卡上、全部从原画抠', async () => {
  const run = async (partsSheet: () => Promise<Img>) => {
    const d = {
      id: 'p1',
      designSize: { X: 400, Y: 260 },
      images: [],
      components: [],
      root: { id: 'r', Type: 'CanvasPanel', Name: 'Root', Properties: {}, Children: [] },
      rev: 0,
    } as unknown as Design
    setSource(d, { kind: 'image', file: 'a.png', name: '', width: 400, height: 260 }, 'now')
    let stored = 0
    const ctx = {
      design: d,
      art: async () => screen(),
      store: async (img: Img) => ({ file: `f${++stored}.png`, width: img.width, height: img.height }),
      layer: async () => sheet(),
      partsSheet,
      thresholds: DEFAULT_THRESHOLDS,
      now: () => 'now',
    }
    confirmStep(d, 'source')
    await runStep('elements', ctx)
    confirmStep(d, 'elements')
    await runStep('assets', ctx)
    return { r: stateOf(d), card: stepOf(d.restore, 'assets').versions.at(-1)!.card }
  }
  const ok = await run(async () => sheet())
  assert.ok(ok.r.parts?.file, '拆件图存下来了')
  const fromParts = ok.r.elements.filter((e) => e.assetFrom === 'parts')
  assert.ok(fromParts.length >= 3, JSON.stringify(ok.r.elements.map((e) => [e.kind, e.assetFrom])))
  assert.ok(fromParts.every((e) => e.sim === undefined && (e.partScore ?? 0) >= 0.6))
  assert.ok(ok.card.metrics.some((m) => m.value.includes('/') && m.label.length > 0))
  const bad = await run(async () => {
    throw new Error('没有图片 CLI')
  })
  assert.equal(bad.r.parts, undefined)
  assert.ok(bad.r.elements.every((e) => e.assetFrom !== 'parts'))
  assert.ok(bad.card.warnings.some((w) => w.includes('没有图片 CLI')))
})
