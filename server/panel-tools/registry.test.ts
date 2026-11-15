import assert from 'node:assert/strict'
import test from 'node:test'
import type { Orchestra } from '../../shared/engine/host.ts'
import { PANEL_TOOL_NAMES } from '../../shared/panel-tools.ts'
import { AUDIENCE_REPS } from '../mcp-catalog/audiences.ts'
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

/**
 * MCP 工具规范（ADR 0066）：面板工具的数量和定义长度只许变少。每个工具的定义每轮都整份进上下文，
 * 加一个工具前先过 ADR 0066 的准入；真要加，在同一个提交里改下面的数，并在提交说明里写清准入理由
 */
const TOOL_COUNT_CAP: Record<string, number> = { parent: 40, child: 28, helper: 12, node: 21, chat: 4 }
/** 一个工具的定义（名字 + 说明 + 参数 schema 的 JSON）最多多少字 */
const DEF_CAP = 3000
/** 规范之前就超了的：只许变短，变短了把数改小 */
const DEF_OVER: Record<string, number> = { submit_diagnosis: 14967, update_bug_case: 14271, spawn_agents: 3598 }

test('MCP 工具规范：面板工具的名字、个数、定义长度不超规范（ADR 0066）', () => {
  for (const [aud, o] of Object.entries(AUDIENCE_REPS)) {
    const defs = orchTools(o)
    assert.ok(
      defs.length <= TOOL_COUNT_CAP[aud],
      `${aud} 拿到 ${defs.length} 个面板工具，超过 ${TOOL_COUNT_CAP[aud]}：先按 ADR 0066 判断能不能并进已有工具`,
    )
    for (const d of defs) {
      assert.match(d.name, /^[a-z][a-z0-9_]{2,29}$/, `${d.name}：工具名用小写下划线，不超过 30 个字符`)
      const len = JSON.stringify(d).length
      const cap = DEF_OVER[d.name] ?? DEF_CAP
      assert.ok(len <= cap, `${d.name} 的定义 ${len} 字，超过 ${cap}：说明只写作用和时机，细节放进返回或用法查询`)
    }
  }
})
