import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canPreset } from './kinds.ts'
import { presetFor, presetGrants } from './preset.ts'

const wf = (grants: { rule: string; label: string }[]) =>
  ({ id: 'w1', grants }) as unknown as Parameters<typeof presetGrants>[0]['workflows'][number]

test('只有插件操作能预授权', () => {
  assert.equal(canPreset('plugin:ue:self-test'), true)
  assert.equal(canPreset('command:git push'), false)
  assert.equal(canPreset('gate:readonly-guard'), false)
})

test('工作流运行认快照里的自带授权，普通对话不认', () => {
  const grants = [
    { rule: 'plugin:ue:self-test', label: '自己测' },
    { rule: 'command:rm', label: '删' },
  ]
  const run = { mode: 'workflow' as const, workflowId: 'w1', workflows: [wf(grants)] }
  assert.deepEqual(
    presetGrants(run).map((g) => g.rule),
    ['plugin:ue:self-test'],
  )
  assert.equal(presetFor(run, 'plugin:ue:self-test')?.label, '自己测')
  assert.equal(presetFor(run, 'command:rm'), undefined)
  assert.equal(presetFor({ mode: 'agent', workflowId: '', workflows: [wf(grants)] }, 'plugin:ue:self-test'), undefined)
})
