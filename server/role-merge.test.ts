import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentInput,
  CategoryInput,
  TagInput,
  Workflow,
  WorkflowInput,
  setAgentAliases,
  type Agent,
} from '../shared/schema.ts'
import { renderTemplate, resolveParams } from '../shared/agent-role.ts'
import { BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
import { LEGACY_AGENT_FIELDS_MORE, MERGED_AGENTS } from '../shared/builtin/legacy.ts'
import {
  pruneMergedAgents,
  redirectMergedProjects,
  seedProjectWorkflows,
  type BuiltinOps,
} from '../shared/builtin/install.ts'

// ---- 内置角色合并成通用角色（调研、方案设计、开发、评审、Blender 建模） ----

const def = (key: string) => BUILTIN_AGENTS.find((b) => b.key === key)!.agent
/** 按参数渲染内置角色的设定，参数没给的按默认值 */
const render = (key: string, values: Record<string, unknown> = {}) =>
  renderTemplate(def(key).instructions, resolveParams(def(key).params, values as never).values)

test('合并后的角色按参数切换做法，模板都能展开干净', () => {
  for (const b of BUILTIN_AGENTS)
    for (const p of b.agent.params) {
      if (p.type !== 'select') continue
      for (const o of p.options) assert.ok(!/\{\{[#/]/.test(render(b.key, { [p.key]: o })), `${b.key}.${p.key}=${o}`)
    }
  assert.match(render('explorer', { target: '外部资料' }), /## 查资料/)
  assert.doesNotMatch(render('explorer', { target: '外部资料' }), /## 定位代码/)
  assert.match(render('explorer', { target: '影响面', stack: 'ue', focus: '资产' }), /Cook 白名单/)
  assert.doesNotMatch(render('explorer'), /Unreal Engine/, '通用项目不带 UE 的规则')
  assert.match(render('developer', { task: '修 Bug' }), /没找到根因不修/)
  assert.doesNotMatch(render('developer', { task: '修 Bug' }), /按已确认的设计/)
  assert.match(render('developer', { task: '性能问题' }), /建立基线/)
  assert.match(render('developer'), /按已确认的设计/)
  assert.match(render('reviewer', { target: '方案或结论' }), /同意 \/ 部分同意 \/ 不同意/)
  assert.match(render('reviewer'), /验收结论/)
  assert.match(render('analyst', { scale: 'architectural', stack: 'ue' }), /架构契约[\s\S]*gameplay-framework\.md/)
  assert.match(render('blender', { stage: '质检' }), /不修改模型/)
  // 每个合并掉的 key 都指向还在的内置角色
  for (const [key, m] of Object.entries(MERGED_AGENTS))
    assert.ok(
      BUILTIN_AGENTS.some((b) => b.key === m.into),
      `${key} → ${m.into}`,
    )
  // 评审现在是通用角色：任何节点都能派它复核
  assert.ok(def('reviewer').common)
})

/** 内存里的一套数据：启动迁移用的接口都记下来 */
function memory(agents: Agent[], workflows: Workflow[]) {
  let n = 0
  const meta = () => ({ id: `id${++n}`, createdAt: '', updatedAt: '' })
  const state = { agents: [...agents], categories: [] as never[], tags: [] as never[], workflows: [...workflows] }
  const ops: BuiltinOps & { deleteAgent: (id: string) => Promise<boolean> } = {
    createAgent: async (a) => {
      const x = { ...AgentInput.parse(a), ...meta() }
      state.agents.push(x)
      return x
    },
    createCategory: async (name, scope) => ({ ...CategoryInput.parse({ name, scope }), ...meta() }),
    createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
    createWorkflow: async (w) => {
      const x = Workflow.parse({ ...WorkflowInput.parse(w), ...meta() })
      state.workflows.push(x)
      return x
    },
    updateWorkflow: async (id, w) => {
      const x = Workflow.parse({ ...w, id, createdAt: '', updatedAt: '' })
      state.workflows = state.workflows.map((y) => (y.id === id ? x : y))
      return x
    },
    updateAgent: async (id, a) => {
      const x = { ...AgentInput.parse(a), id, createdAt: '', updatedAt: '' }
      state.agents = state.agents.map((y) => (y.id === id ? x : y))
      return x
    },
    deleteAgent: async (id) => {
      state.agents = state.agents.filter((a) => a.id !== id)
      return true
    },
  }
  return { state, ops }
}

/** 本机装过的旧内置副本：设定和上一版一模一样（没改过） */
const oldCopy = (key: string, id: string, extra: Partial<Agent> = {}): Agent => ({
  ...AgentInput.parse({ ...LEGACY_AGENT_FIELDS_MORE[key].at(-1)!, origin: `builtin:${key}` }),
  id,
  createdAt: '',
  updatedAt: '',
  ...extra,
})

const node = (id: string, agentId: string, params: Record<string, unknown>) => ({
  id,
  title: id,
  kind: 'agent' as const,
  agentId,
  flow: null,
  tier: 'high' as const,
  params,
  steps: [],
  retries: 0,
  instructions: '我自己写的说明',
  x: 0,
  y: 0,
  hooks: { start: null, review: null, end: null, maxRounds: 3 },
})

test('旧工作流引用合并掉的角色：改指到通用角色并换算参数，缺的目标先建出来；没人用、没改过的旧副本删掉', async () => {
  const mine = Workflow.parse({
    id: 'w1',
    createdAt: '',
    updatedAt: '',
    name: '我的排查流程',
    mainAgentId: 'old-debugger',
    members: [
      { agentId: 'old-debugger', responsibility: '修' },
      { agentId: 'old-impact', responsibility: '看' },
    ],
    entryFlowId: 'main',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          node('perf', 'old-debugger', { scene: true, focus: '性能问题', lang: 'cpp' }),
          node('scout', 'old-uescout', { scene: true, focus: '资产' }),
          node('qa', 'old-qa', {}),
        ],
        edges: [],
      },
    ],
  })
  const { state, ops } = memory(
    [
      oldCopy('debugger', 'old-debugger'),
      oldCopy('impact', 'old-impact'),
      // 用户改过的旧副本：引用照样换掉，但副本留着
      oldCopy('uescout', 'old-uescout', { instructions: '我改过的 UE 侦察' }),
      oldCopy('blenderqa', 'old-qa'),
      // 还被项目用作默认对话角色的：项目改过去后也能删
      oldCopy('second', 'old-second'),
    ],
    [mine],
  )
  const seeded = await seedProjectWorkflows(state, ops)
  const find = (key: string) => seeded.state.agents.find((a) => a.origin === `builtin:${key}`)!
  const dev = find('developer')
  const explorer = find('explorer')
  const blender = find('blender')
  assert.ok(dev && explorer && blender, '合并目标原来没有，先建出来')
  const w = seeded.state.workflows.find((x) => x.id === 'w1')!
  const [perf, scout, qa] = w.flows[0].nodes
  assert.equal(perf.agentId, dev.id)
  assert.deepEqual(perf.params, { scene: true, lang: 'cpp', task: '性能问题' }, '排查方向换算成任务')
  assert.equal(perf.instructions, '我自己写的说明', '节点说明不动')
  assert.equal(scout.agentId, explorer.id)
  assert.deepEqual(scout.params, { scene: true, focus: '资产', target: '影响面', stack: 'ue' })
  assert.equal(qa.agentId, blender.id)
  assert.deepEqual(qa.params, { stage: '质检' })
  assert.equal(w.mainAgentId, dev.id, '主 Agent 一起换')
  assert.deepEqual(
    w.members.map((m) => m.agentId),
    [dev.id, explorer.id],
  )

  const projects = [{ id: 'p1', defaultAgentId: 'old-second' }]
  const moved = redirectMergedProjects(projects as never, seeded.state.agents)
  const reviewer = find('reviewer')
  assert.deepEqual(moved, [{ id: 'p1', defaultAgentId: reviewer.id }])
  // 项目还没改过去时，被项目用着的不删；其余没人用、没改过的删掉
  const first = await pruneMergedAgents(seeded.state, projects, ops)
  assert.deepEqual(first.removed.map((a) => a.id).sort(), ['old-debugger', 'old-impact', 'old-qa'])
  assert.equal(first.aliases['old-debugger'], dev.id, '旧对话里的旧 id 转到合并目标')

  const after = { ...seeded.state, agents: state.agents }
  const pruned = await pruneMergedAgents(after, [{ defaultAgentId: reviewer.id }], ops)
  assert.deepEqual(
    pruned.removed.map((a) => a.id),
    ['old-second'],
  )
  assert.ok(
    state.agents.some((a) => a.id === 'old-uescout'),
    '用户改过的旧副本保留',
  )
  // 再启动一遍：没有可删的，也不再改工作流
  const again = await pruneMergedAgents({ ...after, agents: state.agents }, [], ops)
  assert.equal(again.removed.length, 0)
})

test('删掉的角色登记过以后，旧快照里的引用读出来就是新的', () => {
  setAgentAliases({ 'gone-1': 'new-1' })
  const w = Workflow.parse({
    id: 'w',
    createdAt: '',
    updatedAt: '',
    name: '旧快照',
    mainAgentId: 'gone-1',
    flows: [{ id: 'main', name: '主流程', nodes: [node('a', 'gone-1', {})], edges: [] }],
  })
  assert.equal(w.mainAgentId, 'new-1')
  assert.equal(w.flows[0].nodes[0].agentId, 'new-1')
})
