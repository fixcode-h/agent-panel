import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginManifest, type PluginManifest as Manifest } from './types.ts'
import { setEnabledPlugins, setInstalledPlugins } from './index.ts'
import { fillConfig, pluginTestSteps, setProjectProbe, stepPluginId } from './contrib.ts'
import { currentTestSteps, pickSteps } from '../test-steps.ts'
import type { TestStep } from '../schema.ts'

const ue = PluginManifest.parse({
  id: 'ue',
  name: 'UE',
  version: '1.0.0',
  settings: [{ key: 'editorCmd', type: 'path', label: '编辑器', default: '' }],
  testSteps: [
    {
      id: 'compile-bp',
      name: '编译蓝图',
      command: '"{config.editorCmd}" "{config.missing}" -run=CompileAllBlueprints',
      scope: 'changed',
      appliesTo: ['**/*.uasset'],
      detect: ['*.uproject'],
    },
  ],
  hooks: [{ id: 'after-write', name: '写后编译', event: 'tool.after' }],
  commands: [{ name: 'ue-check', file: 'commands/check.md' }],
}) as unknown as Manifest

const own: TestStep = {
  id: 'tc',
  name: '类型检查',
  command: 'npm run typecheck',
  env: 'auto',
  cwd: '',
  when: '',
  appliesTo: [],
  scope: 'always',
  timeoutSec: 0,
  note: '',
  enabled: true,
  merge: false,
  quick: true,
}

function setup(on: boolean, editorCmd = 'C:/UE/UnrealEditor-Cmd.exe') {
  setInstalledPlugins([ue])
  setEnabledPlugins({ ue: { enabled: on, config: { editorCmd } } })
}

test('插件测试步骤：开着才有，参数换进命令，id 带插件前缀', () => {
  setProjectProbe(() => true)
  setup(true)
  const steps = pluginTestSteps({ path: '/p' })
  assert.equal(steps.length, 1)
  assert.equal(steps[0].id, 'plugin:ue:compile-bp')
  assert.equal(stepPluginId(steps[0]), 'ue')
  assert.equal(stepPluginId(own), '')
  // 没配的参数原样留着，Agent 看得出要去配
  assert.equal(steps[0].command, '"C:/UE/UnrealEditor-Cmd.exe" "{config.missing}" -run=CompileAllBlueprints')
  assert.ok(!('detect' in steps[0]))
  setup(false)
  assert.deepEqual(pluginTestSteps({ path: '/p' }), [])
})

test('插件测试步骤：项目里关掉的、项目根没有 detect 文件的不算', () => {
  setup(true)
  setProjectProbe(() => true)
  assert.deepEqual(pluginTestSteps({ path: '/p', pluginStepsOff: ['plugin:ue:compile-bp'] }), [])
  const seen: [string, string[]][] = []
  setProjectProbe((dir, globs) => (seen.push([dir, globs]), false))
  assert.deepEqual(pluginTestSteps({ path: '/web' }), [])
  assert.deepEqual(seen, [['/web', ['*.uproject']]])
  // 没有项目目录时也不加（detect 没法判断）
  assert.deepEqual(pluginTestSteps({}), [])
  setProjectProbe(() => true)
})

test('currentTestSteps 把插件步骤接在项目步骤后面，按改动一样筛；项目读不到时只用快照', () => {
  setProjectProbe(() => true)
  setup(true)
  const steps = currentTestSteps([], { testSteps: [own], path: '/p' })
  assert.deepEqual(
    steps.map((s) => s.id),
    ['tc', 'plugin:ue:compile-bp'],
  )
  assert.deepEqual(
    pickSteps(steps, ['Source/A.cpp']).run.map((s) => s.id),
    ['tc'],
  )
  assert.deepEqual(
    pickSteps(steps, ['Content/BP_Hero.uasset']).run.map((s) => s.id),
    ['tc', 'plugin:ue:compile-bp'],
  )
  assert.deepEqual(currentTestSteps([own], null), [own])
  setup(false)
})

test('fillConfig 只换认识的参数', () => {
  assert.equal(fillConfig('{config.a} {config.b} {x}', { a: 1, b: '' }), '1 {config.b} {x}')
})

test('清单的三段有默认值，格式不对的拒绝', () => {
  const m = PluginManifest.parse({ id: 'x', name: 'x', version: '1' })
  assert.deepEqual([m.hooks, m.testSteps, m.commands], [[], [], []])
  assert.equal(ue.hooks[0].timeoutSec, 30)
  assert.equal(ue.hooks[0].match.tool, 'any')
  assert.ok(
    !PluginManifest.safeParse({
      id: 'x',
      name: 'x',
      version: '1',
      hooks: [{ id: 'A B', name: 'n', event: 'tool.after' }],
    }).success,
  )
  assert.ok(
    !PluginManifest.safeParse({ id: 'x', name: 'x', version: '1', hooks: [{ id: 'a', name: 'n', event: 'task.done' }] })
      .success,
  )
  assert.ok(
    !PluginManifest.safeParse({ id: 'x', name: 'x', version: '1', commands: [{ name: 'a b', file: 'x.md' }] }).success,
  )
})
