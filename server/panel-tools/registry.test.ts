import assert from 'node:assert/strict'
import test from 'node:test'
import type { Orchestra } from '../../shared/engine/host.ts'
import { PANEL_TOOL_NAMES } from '../../shared/panel-tools.ts'
import { callOrchTool, findTool, orchTools, PANEL_TOOLS, toolHint } from './registry.ts'

const ok = () => ({ ok: true, info: '' })
// 能力全开的调用者：每个条目的 when 都至少在一种身份下为真，这里用来核对定义本身
const ALL = {
  self: 'n1',
  common: [],
  team: true,
  canSpawn: true,
  plans: true,
  planning: true,
  coordinator: true,
  capabilities: true,
  inlineEdit: true,
  child: true,
  claims: true,
  canBackground: true,
  canSubmit: true,
  canBeginEdit: true,
  parentOf: true,
  peers: true,
  sharedState: true,
  ueBuild: 'parent',
  lessons: { find: async () => '', record: ok },
  experience: { find: async () => '', record: ok },
  p4Split: ok,
  cherryPick: ok,
  askPush: ok,
  endTurn: ok,
  requestUserAction: ok,
  diagnose: ok,
  remember: ok,
  submitResult: ok,
  submitVerdict: ok,
} as unknown as Orchestra

test('面板工具注册表：名字都登记过、定义的名字和条目一致、同名的几份不会同时给，执行按名字（含旧名字）找条目', async () => {
  const known = new Set<string>(PANEL_TOOL_NAMES)
  for (const t of PANEL_TOOLS) {
    // 不登记的话对话里会露出原始工具名（shared/panel-tools.ts）
    for (const n of [t.name, ...(t.aliases ?? [])]) assert.ok(known.has(n), `${n} 没登记进 PANEL_TOOL_NAMES`)
    for (const o of [ALL, { ...ALL, ueBuild: 'child', isolated: false } as Orchestra])
      if (t.def && t.when(o)) assert.equal(t.def(o).name, t.name)
  }
  // request_build 有父对话、子对话两份：条件互斥，任何身份的清单里都不会出现两次
  for (const ueBuild of ['', 'child', 'parent'] as const)
    for (const isolated of [true, false]) {
      const names = orchTools({ ...ALL, ueBuild, isolated } as Orchestra).map((x) => x.name)
      assert.equal(new Set(names).size, names.length, `ueBuild=${ueBuild} isolated=${isolated} 的清单有重名`)
    }
  // 说明只在给了这个工具时出现：没有后台命令就不提 run_background
  assert.match(toolHint(ALL, 'run_background', 'conv'), /run_background/)
  assert.equal(toolHint({ ...ALL, canBackground: false } as Orchestra, 'run_background', 'conv'), '')
  // 旧名字照样执行（保活的旧进程还拿着旧清单），只认调用的旧工具不列出
  assert.equal(findTool('submit_build'), findTool('submit_merge'))
  assert.ok(!orchTools(ALL).some((x) => x.name === 'start_plan' || x.name === 'submit_build' || x.name === 'dispatch'))
  assert.match((await callOrchTool(ALL, 'start_plan', {})).content[0].text, /start_workflow/)
  assert.deepEqual(await callOrchTool(ALL, '没有的', {}), {
    content: [{ type: 'text', text: '没有这个工具：没有的' }],
    isError: true,
  })
})
