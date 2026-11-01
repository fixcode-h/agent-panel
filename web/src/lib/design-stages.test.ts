import assert from 'node:assert/strict'
import test from 'node:test'
import { designStages, type StageInput } from './design-stages.ts'

const base: StageInput = { style: '', concepts: 0, approved: false, hasTree: false, images: [] }
const states = (i: Partial<StageInput>) => designStages({ ...base, ...i }).map((s) => `${s.id}:${s.state}`)

test('新设计：第一步风格是当前，其余待做', () => {
  assert.deepEqual(states({}), [
    'style:current',
    'concept:todo',
    'template:todo',
    'ui:todo',
    'slices:todo',
    'export:todo',
  ])
})

test('走原画流程：确认模板后当前是界面；正在出图时切图显示进行中', () => {
  assert.deepEqual(states({ style: 'pixel', concepts: 3, approved: true }).slice(0, 4), [
    'style:done',
    'concept:done',
    'template:done',
    'ui:current',
  ])
  const s = states({
    style: 'pixel',
    concepts: 3,
    approved: true,
    hasTree: true,
    images: [{ status: 'generating', variants: 0 }],
  })
  assert.equal(s[4], 'slices:busy')
})

test('不出原画直接搭界面：原画、模板记为跳过，没定的风格也不再挡着', () => {
  assert.deepEqual(states({ hasTree: true, images: [{ status: 'idle', variants: 1 }] }), [
    'style:skipped',
    'concept:skipped',
    'template:skipped',
    'ui:done',
    'slices:done',
    'export:current',
  ])
})
