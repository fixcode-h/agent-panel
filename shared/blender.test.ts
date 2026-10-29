import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelObject, sceneText } from './blender.ts'

test('sceneText：物体列表压成给 Agent 看的几行，空场景说清楚', () => {
  assert.equal(sceneText([]), '场景是空的。')
  const crate = ModelObject.parse({
    name: 'Crate',
    type: 'MESH',
    location: [2, 0, 0.5],
    dimensions: [1, 1, 1],
    faces: 6,
    materials: ['Wood'],
    modifiers: ['BEVEL'],
  })
  assert.equal(
    sceneText([crate]),
    '- Crate（MESH） · 位置 (2, 0, 0.5) · 尺寸 (1, 1, 1) · 6 面 · 材质 Wood · 修改器 BEVEL',
  )
})
