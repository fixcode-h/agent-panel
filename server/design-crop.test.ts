import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { blank, decodePng, encodePng, paste } from './image.ts'
import { cropTemplate, cropTemplateFile, pickRefined, templatePartCrops } from './design-crop.ts'

/** 2000×1000 的原画（设计稿 1000×500）：深色底，(400,200) 起 200×100 是一块金色 */
function template() {
  const img = blank(2000, 1000, [10, 10, 20, 255])
  paste(img, blank(200, 100, [230, 190, 60, 255]), 400, 200)
  return img
}

test('cropTemplate：按原画的实际分辨率裁，结果正好是显示尺寸、内容填满不留白', () => {
  const out = cropTemplate(
    template(),
    { X: 1000, Y: 500 },
    { ref: { x: 200, y: 100, w: 100, h: 50 }, width: 100, height: 50, transparent: false },
  )!
  assert.equal(out.width, 100)
  assert.equal(out.height, 50)
  // 正中间和四个角都是金色：框就是那一块
  for (const [x, y] of [
    [50, 25],
    [1, 1],
    [98, 48],
  ])
    assert.deepEqual([...out.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)], [230, 190, 60])
})

test('cropTemplate：透明的图标去掉平底，框外落在原画外面时裁到边', () => {
  const tpl = blank(400, 400, [10, 10, 20, 255])
  paste(tpl, blank(40, 40, [200, 60, 60, 255]), 180, 180)
  const out = cropTemplate(
    tpl,
    { X: 400, Y: 400 },
    { ref: { x: 160, y: 160, w: 80, h: 80 }, width: 80, height: 80, transparent: true },
  )!
  assert.equal(out.data[3], 0, '角上是透明的')
  assert.equal(out.data[(40 * 80 + 40) * 4 + 3], 255, '中间的图标不透明')
  assert.equal(
    cropTemplate(
      tpl,
      { X: 400, Y: 400 },
      { ref: { x: 399, y: 0, w: 80, h: 80 }, width: 80, height: 80, transparent: false },
    ),
    undefined,
  )
})

test('cropTemplateFile + pickRefined：精修的没过门槛时选回原画抠的那版，过了选分最高的', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'crop-'))
  try {
    await writeFile(path.join(dir, 'tpl.png'), encodePng(template()))
    const img = { ref: { x: 200, y: 100, w: 100, h: 50 }, width: 100, height: 50, transparent: false }
    const exact = (await cropTemplateFile(path.join(dir, 'tpl.png'), { X: 1000, Y: 500 }, img))!
    assert.equal(decodePng(exact)!.width, 100)
    await writeFile(path.join(dir, 'same.png'), exact)
    await writeFile(path.join(dir, 'off.png'), encodePng(blank(100, 50, [40, 90, 220, 255])))
    const at = new Date().toISOString()
    const crop = { file: 'c.png', source: 'crop' as const, width: 100, height: 50, at, score: 1 }
    const off = { file: 'off.png', source: 'cli' as const, width: 100, height: 50, at }
    const same = { file: 'same.png', source: 'cli' as const, width: 100, height: 50, at }
    const low = await pickRefined(dir, { variants: [crop, off], selected: 1 }, exact, 0.92)
    assert.equal(low.selected, 0)
    assert.ok(low.low! < 0.92)
    const good = await pickRefined(dir, { variants: [crop, off, same], selected: 1 }, exact, 0.92)
    assert.equal(good.selected, 2)
    assert.equal(good.low, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('templatePartCrops：模板模式先出拆件图（模板当参考图）再切，切图按显示尺寸输出；出过的拆件图直接读', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'parts-'))
  try {
    // 模板里金色块中间压着一个红点（别的 UI），拆件图里金色块是干净的一件
    const tpl = template()
    paste(tpl, blank(40, 40, [200, 30, 30, 255]), 480, 230)
    const tplFile = path.join(dir, 'tpl.png')
    await writeFile(tplFile, encodePng(tpl))
    const sheet = blank(600, 400, [0, 0, 0, 0])
    paste(sheet, blank(300, 150, [230, 190, 60, 255]), 100, 100)
    const want = [
      { id: 'a', name: 'Gold', width: 200, height: 100, transparent: false, ref: { x: 200, y: 100, w: 100, h: 50 } },
    ]
    const design = { designSize: { X: 1000, Y: 500 }, kind: 'game' as const, images: [] }
    const refs: string[] = []
    const sheetFile = path.join(dir, 'parts-c1.png')
    const m = await templatePartCrops({
      tplFile,
      sheetFile,
      design,
      want,
      generate: async (_prompt, ref) => {
        refs.push(ref)
        return encodePng(sheet)
      },
    })
    assert.deepEqual(refs, [tplFile])
    const out = decodePng(m!.get('a')!.png)!
    assert.deepEqual([out.width, out.height], [200, 100])
    // 红点的位置是干净的金色
    const o = (25 * 200 + 100) * 4
    assert.deepEqual([...out.data.slice(o, o + 3)], [230, 190, 60])
    const again = await templatePartCrops({
      tplFile,
      sheetFile,
      design,
      want,
      generate: async () => assert.fail('有拆件图时不该再出'),
    })
    assert.ok(again?.has('a'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
