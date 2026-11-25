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

test('节点自带的授权只在跑那个节点（含它下面的记录）时算', () => {
  const w = {
    id: 'w1',
    grants: [],
    flows: [
      {
        id: 'main',
        nodes: [
          { id: 'verify', grants: [{ rule: 'plugin:ue:lua-exec', label: '执行 Lua' }] },
          { id: 'archive', grants: [{ rule: 'command:rm', label: '删' }] },
        ],
      },
    ],
  } as unknown as Parameters<typeof presetGrants>[0]['workflows'][number]
  const steps = [
    { id: 'verify', workflowId: 'w1', flowId: 'main', nodeId: 'verify' },
    { id: 'archive', workflowId: 'w1', flowId: 'main', nodeId: 'archive' },
  ] as unknown as NonNullable<Parameters<typeof presetFor>[0]['steps']>
  const run = { mode: 'workflow' as const, workflowId: 'w1', workflows: [w], steps }
  assert.equal(presetFor(run, 'plugin:ue:lua-exec', 'verify')?.label, '执行 Lua')
  assert.equal(presetFor(run, 'plugin:ue:lua-exec', 'verify/helper/h1')?.label, '执行 Lua')
  assert.equal(presetFor(run, 'plugin:ue:lua-exec', 'archive'), undefined)
  assert.equal(presetFor(run, 'plugin:ue:lua-exec'), undefined)
  // 不能预授权的类型（命令）节点上写了也不认
  assert.equal(presetFor(run, 'command:rm', 'archive'), undefined)
})
