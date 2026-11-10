import assert from 'node:assert/strict'
import test from 'node:test'
import { writePsdBuffer, type Layer, type Psd } from 'ag-psd'
import { blank, paste, type Img } from '../shared/raster.ts'
import type { Design } from '../shared/design.ts'
import { importPsd } from '../shared/restore/psd.ts'
import { confirmStep, runStep, setSource, stateOf } from '../shared/restore/steps.ts'
import { stepOf } from '../shared/restore/schema.ts'
import { DEFAULT_THRESHOLDS } from '../shared/restore/thresholds.ts'
import { walk } from '../shared/umg.ts'
import { isPsd, readPsdLayers } from './design-psd.ts'

const solid = (w: number, h: number, c: number[]) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(c, i * 4)
  return { width: w, height: h, data }
}
const px = (name: string, x: number, y: number, w: number, h: number, c: number[], extra: Partial<Layer> = {}) =>
  ({ name, left: x, top: y, imageData: solid(w, h, c), ...extra }) as Layer

/** 一张小背包：背景、主面板组（有底图）、3 个格子、按钮组（常态 + 悬停）、一个隐藏图层、一个中文名图标 */
function sample(): Psd {
  const psd: Psd = {
    width: 400,
    height: 300,
    children: [
      px('背景', 0, 0, 400, 300, [20, 20, 30, 255]),
      {
        name: 'Panel_Bag',
        children: [
          px('bg', 40, 30, 320, 240, [60, 40, 80, 255]),
          px('Slot_1', 60, 50, 50, 50, [10, 10, 20, 255]),
          px('Slot_2', 120, 50, 50, 50, [10, 10, 20, 255]),
          px('Slot_3', 180, 50, 50, 50, [10, 10, 20, 255]),
          px('宝石', 70, 60, 30, 30, [80, 160, 240, 255]),
          px('Deco_Old', 0, 0, 10, 10, [255, 0, 0, 255], { hidden: true }),
          {
            name: 'Btn_Use',
            children: [
              px('Btn_Use@normal', 240, 200, 100, 40, [200, 100, 50, 255]),
              px('Btn_Use@hover', 240, 200, 100, 40, [230, 130, 80, 255]),
            ],
          },
        ],
      },
    ],
  }
  // 合成图：可见图层从下到上叠起来（PS 存的那张就是这样来的）
  const comp = blank(400, 300, [0, 0, 0, 255])
  const draw = (list: Layer[]) => {
    for (const l of list) {
      if (l.hidden) continue
      if (l.children) draw(l.children.filter((k) => !/@hover/.test(k.name ?? '')))
      else if (l.imageData)
        paste(comp, { ...l.imageData, data: new Uint8Array(l.imageData.data.buffer) }, l.left ?? 0, l.top ?? 0)
    }
  }
  draw(psd.children!)
  psd.imageData = { ...comp, data: new Uint8ClampedArray(comp.data.buffer) }
  return psd
}

test('importPsd：按命名约定定类型和名字，按钮的悬停图层归按钮，容器底图归容器，隐藏的不要', () => {
  const p = importPsd(sample())
  const by = (name: string) => p.elements.find((e) => e.name === name)
  assert.deepEqual(by('Panel_Bag')?.box, { x: 40, y: 30, w: 320, h: 240 }, '面板的范围就是底图')
  assert.ok(by('Panel_Bag')?.layer, '面板底图')
  assert.equal(p.elements.filter((e) => e.kind === 'slot').length, 3)
  const btn = p.elements.find((e) => e.kind === 'button')!
  assert.equal(btn.name, 'Btn_Use')
  assert.ok(btn.layer && btn.states?.hover && btn.layer !== btn.states.hover, '常态和悬停各一张')
  assert.ok(!p.elements.some((e) => e.name.includes('Old')), '隐藏图层跳过')
  // 中文名的图层按大小猜成图标，名字按类型编号；背景铺满整张
  const gem = p.elements.find((e) => e.box.x === 70 && e.box.y === 60)!
  assert.deepEqual([gem.kind, gem.name], ['icon', 'Icon_1'])
  assert.equal(p.elements.find((e) => e.kind === 'background')?.name, 'Bg_Main')
  assert.ok(p.elements.every((e) => e.source === 'psd'))
})

test('importPsd：文字图层读内容、字号、颜色、对齐，不拿像素当切图', () => {
  const psd: Psd = {
    width: 200,
    height: 100,
    children: [
      {
        name: 'Txt_Title',
        left: 20,
        top: 10,
        imageData: solid(80, 24, [255, 255, 255, 255]),
        text: {
          text: '背包',
          transform: [1, 0, 0, 2, 0, 0],
          style: { fontSize: 12, fillColor: { r: 243, g: 210, b: 122 }, fauxBold: true },
          paragraphStyle: { justification: 'center' },
        },
      },
    ],
  }
  const e = importPsd(psd).elements.find((x) => x.kind === 'text')!
  assert.deepEqual(e.text, { content: '背包', px: 20, color: '#F3D27AFF', align: 'center', bold: true })
  assert.equal(e.layer, undefined)
  assert.equal(e.name, 'Txt_Title')
})

test('PSD 走完六步：读文件、拆解不检测、切图用图层像素、按钮悬停用 PSD 里的那张、校验全过', async () => {
  const buf = writePsdBuffer(sample())
  assert.ok(isPsd(buf))
  const p = readPsdLayers(buf)
  assert.equal(p.layers.length, 8)
  const files = new Map<string, Img>()
  const keyToFile = new Map(p.layers.map((l) => [l.key, `${l.key}.png`]))
  for (const l of p.layers) files.set(`${l.key}.png`, l.img)
  const elements = p.elements.map((e) => ({
    ...e,
    layer: e.layer && keyToFile.get(e.layer),
    ...(e.states ? { states: { hover: e.states.hover && keyToFile.get(e.states.hover) } } : {}),
  }))
  const d = {
    id: 'd1',
    designSize: { X: 800, Y: 600 },
    images: [],
    components: [],
    root: { id: 'r', Type: 'CanvasPanel', Name: 'Root', Properties: {}, Children: [] },
    rev: 0,
  } as unknown as Design
  setSource(d, { kind: 'psd', file: 'art.png', name: 'bag.psd', width: 400, height: 300 }, 'now', {
    elements,
    warnings: p.warnings,
  })
  let stored = 0
  const ctx = {
    design: d,
    art: async () => p.composite,
    store: async (img: Img) => ({ file: `s${++stored}.png`, width: img.width, height: img.height }),
    layer: async (f: string) => files.get(f)!,
    // 不该被叫到：PSD 不用模型标注
    label: async () => assert.fail('PSD 不问模型'),
    thresholds: DEFAULT_THRESHOLDS,
    now: () => 'now',
  }
  assert.equal(confirmStep(d, 'source'), 'elements')
  for (const [step, next] of [
    ['elements', 'assets'],
    ['assets', 'build'],
    ['build', 'verify'],
    ['verify', 'deliver'],
  ] as const) {
    await runStep(step, ctx)
    assert.equal(stepOf(d.restore, step).status, 'review', `${step}: ${stepOf(d.restore, step).error}`)
    assert.equal(confirmStep(d, step), next)
  }
  const r = stateOf(d)
  assert.equal(r.groups.length, 1, '三个格子排成一组')
  assert.ok(
    d.images.some((i) => i.id.endsWith('_hover')),
    '悬停态存了一张',
  )
  let btn: any
  walk(d.root, (w) => {
    if (w.Type === 'Button') btn = w
  })
  assert.notEqual(btn.Properties.WidgetStyle.Hovered.ResourceObject, btn.Properties.WidgetStyle.Normal.ResourceObject)
  assert.ok(r.score?.passed, JSON.stringify(r.score?.items.filter((i) => !i.ok)))
})
