import assert from 'node:assert/strict'
import test from 'node:test'
import { Annotation, annotationBox, annotationText, canInpaint, hasMask, imageRevisionText, maskBox } from './design.ts'

const mask = (strokes: { erase?: boolean; w?: number; points: number[] }[]): Annotation => {
  const list = strokes.map((s) => ({ erase: false, w: 40, ...s }))
  const b = maskBox(list)
  return {
    id: 'm1',
    kind: 'change',
    shape: 'mask',
    points: [b.x, b.y, b.w, b.h],
    strokes: list,
    note: '',
    target: 'concept:c1_1',
    widgets: [],
  }
}

test('旧标注没有 strokes 也能解析，蒙版笔画缺省为空', () => {
  const old = Annotation.parse({ id: 'a1', shape: 'rect', points: [10, 20, 30, 40] })
  assert.deepEqual(old.strokes, [])
  const parsed = Annotation.parse({
    id: 'm1',
    shape: 'mask',
    points: [10, 10, 20, 20],
    strokes: [{ points: [10, 10, 30, 30] }],
  })
  assert.equal(parsed.strokes[0].w, 48)
  assert.equal(parsed.strokes[0].erase, false)
})

test('maskBox 只算涂抹笔画并把笔宽包进去，擦掉的笔画不扩大范围', () => {
  const b = maskBox([
    { points: [100, 100, 200, 100], w: 40 },
    { erase: true, points: [0, 0, 400, 400], w: 80 },
  ])
  assert.deepEqual(b, { x: 80, y: 80, w: 140, h: 40 })
  assert.deepEqual(maskBox([]), { x: 0, y: 0, w: 0, h: 0 })
})

test('annotationBox 把蒙版的 points 当外框', () => {
  assert.deepEqual(annotationBox({ shape: 'mask', points: [10, 20, 30, 40] }), { x: 10, y: 20, w: 30, h: 40 })
  assert.deepEqual(annotationBox(mask([{ points: [100, 100, 100, 100] }])), {
    x: 80,
    y: 80,
    w: 40,
    h: 40,
  })
})

test('hasMask 要求有真的涂抹笔画', () => {
  assert.equal(hasMask(mask([{ points: [10, 10, 20, 20] }])), true)
  assert.equal(hasMask(mask([{ erase: true, points: [10, 10, 20, 20] }])), false)
  assert.equal(hasMask({ shape: 'rect', strokes: [{ erase: false, w: 10, points: [1, 2, 3, 4] }] }), false)
})

test('发给 AI 的标注说明写明蒙版只重绘覆盖的区域', () => {
  const text = annotationText([mask([{ points: [10, 10, 30, 30] }])], { X: 100, Y: 100 })
  assert.match(text, /蒙版涂抹/)
  assert.match(text, /只重绘蒙版覆盖的区域/)
})

test('修改意见把蒙版写成只重绘该区域', () => {
  const a = mask([{ points: [50, 50], w: 2 }])
  const text = imageRevisionText('', [a], { X: 100, Y: 100 })
  assert.match(text, /Redraw only inside the area x 49%–51%, y 49%–51%/)
  assert.match(text, /keep everything outside that area exactly as it is/)
})

test('只有本机 ComfyUI 能做局部重绘', () => {
  assert.equal(canInpaint({ kind: 'local' }), true)
  assert.equal(canInpaint({ kind: 'cli' }), false)
  assert.equal(canInpaint({ kind: 'browser' }), false)
  assert.equal(canInpaint({ kind: 'none' }), false)
})
