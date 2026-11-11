import assert from 'node:assert/strict'
import test from 'node:test'
import { mossBbox, mossLayoutJson, type MossLayoutItem } from './moss.ts'

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
