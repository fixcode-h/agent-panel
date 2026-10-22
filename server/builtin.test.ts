import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentInput, Project, ProjectCategory, Workflow, WorkflowInput, type Agent } from '../shared/schema.ts'
import { composeRole, nodeMissingParams, resolveParams } from '../shared/agent-role.ts'
import { findRefCycle, nodeSteps, topoOrder } from '../shared/flow.ts'
import { frontField } from '../shared/library.ts'
import { DEFAULT_WORKFLOW_ID, defaultWorkflow } from '../shared/builtin/default.ts'
import { BUILTIN_AGENTS, COMMON_AGENT_KEYS } from '../shared/builtin/agents.ts'
import {
  BUILTIN_WORKFLOWS,
  buildWorkflow,
  builtinAgentKeys,
  GENERAL,
  GENERAL_LEGACY,
  GENERAL_ORIGIN,
} from '../shared/builtin/workflows.ts'
import {
  annotateMergedAgents,
  migrateGeneralWorkflow,
  migrateProjectsToGeneral,
  seedBuiltins,
  seedProjectWorkflows,
  upgradeBuiltinAgents,
  type BuiltinOps,
} from '../shared/builtin/install.ts'
import { LEGACY_AGENT_FIELDS, LEGACY_AGENT_FIELDS_MORE, LEGACY_WORKFLOWS } from '../shared/builtin/legacy.ts'
import { CategoryInput, TagInput } from '../shared/schema.ts'
import { ensureBundled, installBundled, listBundled } from './bundled-skills.ts'

const root = path.resolve(import.meta.dirname, '..', 'skills')
const skillDirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((c) =>
    readdirSync(path.join(root, c.name), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ category: c.name, name: d.name })),
  )

// 内置 Agent 当成本机已经建好的 Agent（id 就用 key）
const agents: Agent[] = BUILTIN_AGENTS.map((b) => ({
  ...AgentInput.parse({ ...b.agent, includes: b.includes }),
  id: b.key,
  createdAt: '',
  updatedAt: '',
}))

test('自带 Skill：名字和文件夹一致、不重名、写了说明', () => {
  assert.ok(skillDirs.length >= 15)
  const names = skillDirs.map((s) => s.name)
  assert.equal(new Set(names).size, names.length, '不同分类里有同名的 Skill')
  for (const s of skillDirs) {
    const text = readFileSync(path.join(root, s.category, s.name, 'SKILL.md'), 'utf8')
    assert.equal(frontField(text, 'name'), s.name, `${s.name} 的 name 和文件夹名不一致`)
    const desc = frontField(text, 'description')
    assert.ok(desc.length > 10 && desc.length <= 1024, `${s.name} 的 description 不合适`)
    assert.ok(!text.startsWith('﻿'), `${s.name} 带了 BOM`)
  }
})

test('内置 Agent：引用的 Skill 都是自带的，引入的 Agent 存在，角色设定能拼出来', () => {
  const names = new Set(skillDirs.map((s) => s.name))
  const keys = new Set(BUILTIN_AGENTS.map((b) => b.key))
  assert.equal(keys.size, BUILTIN_AGENTS.length, 'key 重复')
  for (const b of BUILTIN_AGENTS) {
    for (const s of b.agent.skills)
      // {{槽名}} 是工作流暴露项的技能槽，新建对话时按项目设置换成具体的技能
      if (!/^\{\{[\w-]+\}\}$/.test(s)) assert.ok(names.has(s), `${b.agent.name} 引用的 Skill「${s}」不存在`)
    for (const k of b.includes) assert.ok(keys.has(k), `${b.agent.name} 引入的「${k}」不存在`)
    const a = agents.find((x) => x.id === b.key)!
    const role = composeRole(a, agents)
    // 默认参数下模板都能展开，不留下没处理的写法
    assert.doesNotMatch(role, /\{\{/, `${b.agent.name} 的角色设定里有没展开的模板`)
    for (const p of b.agent.params)
      if (p.type === 'select')
        assert.ok(p.options.includes(String(p.default)), `${b.agent.name} 的参数 ${p.key} 默认值不在选项里`)
  }
  // 除了「通用约束」自己，都引入了它
  for (const a of agents.filter((x) => x.id !== 'rules')) assert.ok(a.includes.includes('rules'), a.name)
})

test('内置工作流：结构合法，节点的 Agent、验收流程和参数都对得上', () => {
  for (const w of BUILTIN_WORKFLOWS) {
    const keys = builtinAgentKeys(w)
    for (const k of keys)
      assert.ok(
        agents.some((a) => a.id === k),
        `${w.name} 用到的 Agent「${k}」不存在`,
      )
    const built = WorkflowInput.parse(buildWorkflow(w, (k) => k))
    const wf = { ...built, id: w.key, createdAt: '', updatedAt: '' }
    assert.equal(findRefCycle(wf, [wf]), null, `${w.name} 的流程互相引用`)
    for (const f of built.flows) {
      assert.equal(topoOrder(f).length, f.nodes.length, `${w.name}/${f.name} 有环或连不上的节点`)
      const ids = new Set(f.nodes.map((n) => n.id))
      for (const e of f.edges) {
        assert.ok(ids.has(e.from) || e.from === 'start', `${w.name}/${f.name} 连线起点 ${e.from} 不存在`)
        assert.ok(ids.has(e.to) || e.to === 'end', `${w.name}/${f.name} 连线终点 ${e.to} 不存在`)
      }
      for (const n of f.nodes) {
        for (const s of nodeSteps(n)) {
          if (s.review)
            assert.ok(
              built.flows.some((x) => x.id === s.review!.id),
              `${n.title}/${s.title} 的验收流程不存在`,
            )
          if (s.kind !== 'agent') continue
          const a = agents.find((x) => x.id === s.agentId)
          assert.ok(a, `${w.name}/${n.title}/${s.title} 的 Agent 不存在`)
          // 节点 / 步骤上写的参数都是这个 Agent 的，值也合法
          for (const [k, v] of Object.entries(s.params)) {
            const param: Agent['params'][number] | undefined = a.params.find((x) => x.key === k)
            assert.ok(param, `${w.name}/${n.title}/${s.title} 的参数 ${k} 不是「${a.name}」的`)
            assert.deepEqual(
              resolveParams([param], { [k]: v }).values[k],
              v,
              `${w.name}/${n.title}/${s.title} 的参数 ${k} 值不合法`,
            )
          }
          assert.deepEqual(nodeMissingParams(a, s.params), [], `${w.name}/${n.title}/${s.title} 有没填的参数`)
        }
      }
    }
  }
})

test('旧「通用项目」副本：语义没改时升级成合并后的主流程，保留坐标，重复启动不再改', async () => {
  const mine = agents.map((a) => ({ ...a, origin: `builtin:${a.id}` }))
  const legacy = WorkflowInput.parse({
    ...buildWorkflow(GENERAL_LEGACY, (k) => k),
    name: '通用项目',
    categoryId: 'cat',
    tags: ['tag'],
    origin: GENERAL_ORIGIN,
  })
  const mainOld = legacy.flows.find((f) => f.id === 'main')!
  mainOld.nodes.find((n) => n.id === 'discover')!.x = 111
  mainOld.nodes.find((n) => n.id === 'design')!.x = 222
  mainOld.nodes.find((n) => n.id === 'docs')!.x = 333
  mainOld.startPos = { x: -5, y: 6 }
  const w: Workflow = { ...legacy, id: 'w1', createdAt: '', updatedAt: '' }

  let saved: Workflow | null = null
  const meta = () => ({ id: 'new', createdAt: '', updatedAt: '' })
  const ops: BuiltinOps = {
    createAgent: async (a) => ({ ...AgentInput.parse(a), ...meta() }),
    createCategory: async (name, scope) => ({ ...CategoryInput.parse({ name, scope }), ...meta() }),
    createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
    createWorkflow: async (x) => ({ ...WorkflowInput.parse(x), ...meta() }),
    updateWorkflow: async (id, input) => {
      saved = { ...WorkflowInput.parse(input), id, createdAt: '', updatedAt: '' }
      return saved
    },
  }
  const state = { agents: mine, categories: [], tags: [], workflows: [w] }
  const r = await seedProjectWorkflows(state, ops)
  assert.ok(saved, '旧副本被升级')
  const next = r.state.workflows.find((x) => x.id === 'w1')!
  const main = next.flows.find((f) => f.id === 'main')!
  assert.deepEqual(
    main.nodes.map((n) => n.id),
    ['discover', 'design', 'docs'],
  )
  assert.deepEqual(
    main.nodes.find((n) => n.id === 'design')!.steps.map((s) => s.id),
    ['plan', 'impl'],
  )
  assert.deepEqual(
    main.nodes.find((n) => n.id === 'docs')!.steps.map((s) => s.id),
    ['docsync', 'deliver'],
  )
  // 坐标和工作流级字段都保留
  assert.equal(main.nodes.find((n) => n.id === 'design')!.x, 222)
  assert.deepEqual(main.startPos, { x: -5, y: 6 })
  assert.equal(next.name, '通用项目')
  assert.equal(next.categoryId, 'cat')
  assert.deepEqual(next.tags, ['tag'])
  assert.equal(next.origin, GENERAL_ORIGIN)
  // 再启动一次：结构已经不匹配，不再更新
  let again = 0
  const r2 = await seedProjectWorkflows(r.state, {
    ...ops,
    updateWorkflow: async () => {
      again++
      return null
    },
  })
  assert.equal(again, 0)
  assert.equal(r2.updated.length, 0)
  // 用户改过的副本不动
  const edited = structuredClone(r.state)
  const em = edited.workflows.find((x) => x.id === 'w1')!.flows.find((f) => f.id === 'main')!
  em.nodes.find((n) => n.id === 'discover')!.title = '我改过的'
  assert.equal(await migrateGeneralWorkflow(edited, ops), null)
  assert.ok(GENERAL.flows.find((f) => f.id === 'main')!.nodes.some((n) => n.steps?.length))
})

test('自带 Skill：统一装到 ~/.agents/skills，已有的不覆盖，执行前自动补齐缺的', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bundled-'))
  const old = { ...process.env }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const list = await listBundled()
    assert.equal(list.length, skillDirs.length)
    assert.ok(list.every((s) => s.status.shared === 'missing'))
    const one = list.find((s) => s.name === 'blender')!
    assert.ok(one.files > 5, '带上了脚本和参考资料')

    const r = await installBundled(['blender'], [], false)
    assert.deepEqual(r.done, ['blender'])
    const dir = path.join(home, '.agents/skills/blender')
    assert.ok(existsSync(path.join(dir, 'SKILL.md')))
    assert.ok(existsSync(path.join(dir, 'scripts/inspect_scene.py')))
    assert.equal((await listBundled()).find((s) => s.name === 'blender')!.status.shared, 'same')

    // 用户改过的：不覆盖，状态是「不同」；明确覆盖时换回自带的
    writeFileSync(path.join(dir, 'SKILL.md'), '改过')
    assert.equal((await listBundled()).find((s) => s.name === 'blender')!.status.shared, 'changed')
    assert.deepEqual((await installBundled(['blender'], [], false)).skipped, ['blender'])
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')
    await installBundled(['blender'], [], true)
    assert.notEqual(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')

    // 执行前补齐：只装缺的、只装自带的，用户的同名 Skill 不动
    writeFileSync(path.join(dir, 'SKILL.md'), '用户的')
    const added = await ensureBundled(['blender', 'grilling', '不存在的'])
    assert.deepEqual(added, ['grilling'])
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '用户的')
  } finally {
    process.env = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('首次启动装上全部内置工作流：Agent 只建一份并互相引用好，分类、标签按名字复用', async () => {
  let n = 0
  const meta = () => ({ id: `id${++n}`, createdAt: '', updatedAt: '' })
  const ops: BuiltinOps = {
    createAgent: async (a) => ({ ...AgentInput.parse(a), ...meta() }),
    createCategory: async (name, scope) => ({ ...CategoryInput.parse({ name, scope }), ...meta() }),
    createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
    createWorkflow: async (w) => ({ ...WorkflowInput.parse(w), ...meta() }),
  }
  const mine = { ...AgentInput.parse({ name: '开发' }), ...meta() }
  const r = await seedBuiltins({ agents: [mine], categories: [], tags: [], workflows: [] }, ops)
  assert.equal(r.workflows.length, BUILTIN_WORKFLOWS.length)
  const built = r.agents.filter((a) => a.origin.startsWith('builtin:'))
  // 必备角色「子任务」不在任何工作流里，由启动时的必备角色检查装上
  assert.equal(built.length, BUILTIN_AGENTS.filter((b) => b.key !== 'helper').length, '每个内置 Agent 只建一份')
  // 和用户自己的 Agent 重名时加后缀，两个都在
  assert.ok(r.agents.some((a) => a.name === '开发（内置）' && a.origin === 'builtin:developer'))
  const rules = built.find((a) => a.origin === 'builtin:rules')!
  for (const a of built.filter((x) => x !== rules)) assert.deepEqual(a.includes, [rules.id], a.name)
  // 工作流节点都指向建好的 Agent
  const ids = new Set(r.agents.map((a) => a.id))
  for (const w of r.workflows)
    for (const f of w.flows)
      for (const nd of f.nodes)
        for (const s of nodeSteps(nd)) if (s.kind === 'agent') assert.ok(ids.has(s.agentId), `${nd.title}/${s.title}`)
  assert.equal(r.tags.filter((x) => x.name === '内置').length, 1)
  assert.equal(new Set(r.categories.map((c) => `${c.scope}/${c.name}`)).size, r.categories.length, '分类没有重复')
  // 通用 Agent 跟着工作流一起建，标成通用
  assert.ok(COMMON_AGENT_KEYS.length >= 3)
  for (const k of COMMON_AGENT_KEYS) assert.ok(built.find((a) => a.origin === `builtin:${k}`)?.common, k)
  assert.equal(built.filter((a) => a.common).length, COMMON_AGENT_KEYS.length)
  // 再跑一遍：已有的跳过，不重复建
  const again = await seedBuiltins(r, ops)
  assert.equal(again.workflows.length, r.workflows.length)
  assert.equal(again.agents.length, r.agents.length)
})

test('没改过的旧「测试运行」升级成「测试验收」，改过的不动；重复启动不再改', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  const oldTester = {
    ...agents.find((a) => a.id === 'tester')!,
    ...LEGACY_AGENT_FIELDS.tester,
    id: 'local-tester',
    origin: 'builtin:tester',
    params: [],
    skills: [],
  }
  const state = { agents: [oldTester], categories: [], tags: [], workflows: [] }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 1)
  const next = updated[0]
  assert.equal(next.name, '测试验收')
  assert.ok(next.params.some((p) => p.key === 'scope'))
  assert.equal(next.enabled, oldTester.enabled)
  // 再启动：名字已经不是旧指纹，不再改
  saved.length = 0
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0)

  // 用户改过简介的不升级
  const edited = { ...oldTester, id: 'my-tester', description: '我自己改过的说明' }
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: [edited] }, ops)).length, 0)
})

test('没改过的旧「通用约束」「任务 Agent」（现在的「执行」）跟着升级到新规则；改过的不动', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  const old = (key: 'rules' | 'worker', id: string) => ({
    ...agents.find((a) => a.id === key)!,
    ...LEGACY_AGENT_FIELDS[key],
    id,
    origin: `builtin:${key}`,
    params: [],
    skills: [],
  })
  const state = {
    agents: [old('rules', 'local-rules'), old('worker', 'local-worker')],
    categories: [],
    tags: [],
    workflows: [],
  }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 2, '两个旧副本都升级')
  const rules = updated.find((a) => a.name === '通用约束')!
  assert.match(rules.instructions, /共用工作区/, '补上共用工作区规则')
  assert.match(rules.instructions, /怎么等，什么时候算阻塞/, '补上等待与阻塞判定')
  assert.doesNotMatch(rules.instructions, /单次不超过 60 秒/, '旧的 60 秒轮询规则已经换成新的等待规则')
  const worker = updated.find((a) => a.name === '执行')!
  assert.match(worker.instructions, /没有开启按工作流执行计划的能力/, '补上不能起计划时怎么退化成对话')
  // 再启动：已经不是旧指纹，不再改
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0)

  // 用户改过的保留原样
  const edited = { ...old('rules', 'mine'), instructions: `${LEGACY_AGENT_FIELDS.rules.instructions}\n我自己加的一条` }
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: [edited] }, ops)).length, 0)
})

test('停在上一版的「通用约束」「代码侦察」也能升级（「代码侦察」现在是「调研」）：补回合推进和派工失败的交付底线', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  // 上一版已经发布过的副本：上一版=现在线上用户手里那份（见 LEGACY_AGENT_FIELDS_MORE）
  const prev = (key: 'rules' | 'explorer', id: string) => ({
    ...agents.find((a) => a.id === key)!,
    ...LEGACY_AGENT_FIELDS_MORE[key][0],
    id,
    origin: `builtin:${key}`,
    params: [],
    skills: [],
  })
  const state = {
    agents: [prev('rules', 'local-rules'), prev('explorer', 'local-explorer')],
    categories: [],
    tags: [],
    workflows: [],
  }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 2, '两个上一版副本都升级')
  const rules = updated.find((a) => a.name === '通用约束')!
  assert.match(rules.instructions, /## 回合怎么推进/, '补上一句就停、报错不交结果的规则')
  assert.match(rules.instructions, /我先读取/, '点名只说一句「我先读取…」就结束回合的写法')
  assert.match(rules.instructions, /共用工作区/, '更早一版的规则不能被覆盖掉')
  const explorer = updated.find((a) => a.name === '调研')!
  assert.match(explorer.instructions, /不要空手结束/, '派工失败也要交出已确认的部分')
  assert.match(explorer.instructions, /不要重复读/, '不重复读父对话已经查过的资料')

  // 再启动：已经不是任何旧指纹，不再改
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0)
  // 已经是最新定义的副本同样不动
  const current = {
    ...prev('explorer', 'now'),
    ...BUILTIN_AGENTS.find((b) => b.key === 'explorer')!.agent,
  }
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: [current] }, ops)).length, 0)
})

test('通用约束：上一版副本升级后补上「已授权的操作照做」，再启动不再改', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  const last = LEGACY_AGENT_FIELDS_MORE.rules.at(-1)!
  const state = {
    agents: [
      {
        ...agents.find((a) => a.id === 'rules')!,
        ...last,
        id: 'local-rules',
        origin: 'builtin:rules',
        params: [],
        skills: [],
      },
    ],
    categories: [],
    tags: [],
    workflows: [],
  }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 1, '上一版副本升级')
  assert.match(updated[0].instructions, /用户已经明确授权的操作照授权的做/)
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0)
})

test('已合并的内置 Agent 在本机还有时补一句说明，重复启动不重复加', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  const verifier = {
    ...agents.find((a) => a.id === 'reviewer')!,
    id: 'local-verifier',
    name: '验收员',
    description: '查回归',
    origin: 'builtin:verifier',
  }
  const state = { agents: [verifier], categories: [], tags: [], workflows: [] }
  const [next] = await annotateMergedAgents(state, ops)
  assert.match(next.description, /已合并到「测试与验收」/)
  assert.equal((await annotateMergedAgents({ ...state, agents: [next] }, ops)).length, 0)
})

test('旧项目迁移：指向内置「默认」工作流的也改用「通用项目」', async () => {
  const general = Workflow.parse({
    ...buildWorkflow(GENERAL, (k) => k),
    id: 'g',
    name: '通用项目',
    origin: GENERAL_ORIGIN,
    createdAt: '',
    updatedAt: '',
  })
  const fallback = Workflow.parse(defaultWorkflow())
  const custom = Workflow.parse({ ...defaultWorkflow(), id: 'w', name: '自定义' })
  const cat = ProjectCategory.parse({ id: 'cat', name: '分类', workflowId: 'w', createdAt: '', updatedAt: '' })
  const catDefault = ProjectCategory.parse({
    id: 'cat-default',
    name: '默认分类',
    workflowId: DEFAULT_WORKFLOW_ID,
    createdAt: '',
    updatedAt: '',
  })
  const project = (id: string, workflowId: string, categoryId = '') =>
    Project.parse({ id, name: id, workflowId, categoryId, createdAt: '', updatedAt: '' })

  const moved = await migrateProjectsToGeneral(
    [
      project('custom', 'w'),
      project('follow-cat', '', 'cat'),
      project('default-wf', DEFAULT_WORKFLOW_ID),
      project('follow-default-cat', '', 'cat-default'),
      project('empty', ''),
      project('missing', 'gone'),
    ],
    [general, fallback, custom],
    [cat, catDefault],
  )
  assert.deepEqual(
    moved.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'default-wf', workflowId: 'g' },
      { id: 'empty', workflowId: 'g' },
      { id: 'follow-default-cat', workflowId: 'g' },
      { id: 'missing', workflowId: 'g' },
    ],
  )
})

test('没改过的「开发」和「Bug 修复」升级成按模块逐层定位，再启动不再改', async () => {
  const saved: Agent[] = []
  const agentOps = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  const prev = {
    ...agents.find((a) => a.id === 'developer')!,
    ...LEGACY_AGENT_FIELDS_MORE.developer.at(-1)!,
    id: 'local-dev',
    origin: 'builtin:developer',
  }
  const st = { agents: [prev], categories: [], tags: [], workflows: [] }
  const up = await upgradeBuiltinAgents(st, agentOps)
  assert.equal(up.length, 1, '上一版「开发」升级')
  assert.match(up[0].instructions, /按模块逐层定位/)
  assert.equal((await upgradeBuiltinAgents({ ...st, agents: up }, agentOps)).length, 0, '再启动不再改')

  // 「Bug 修复」：上一版的说明和主流程（验收流程没变，照新定义）
  const def = BUILTIN_WORKFLOWS.find((w) => w.key === 'bugfix')!
  const old = LEGACY_WORKFLOWS.bugfix.at(-1)!
  const mine = agents.map((a) => ({ ...a, origin: `builtin:${a.id}` }))
  const legacy = WorkflowInput.parse({
    ...buildWorkflow(
      { ...def, document: old.document, flows: [...old.flows, ...def.flows.filter((f) => f.id !== 'main')] },
      (k) => k,
    ),
    categoryId: 'cat',
    tags: [],
    origin: 'builtin:bugfix',
  })
  let wf: Workflow | null = null
  const meta = () => ({ id: 'new', createdAt: '', updatedAt: '' })
  const ops: BuiltinOps = {
    createAgent: async (a) => ({ ...AgentInput.parse(a), ...meta() }),
    createCategory: async (name, scope) => ({ ...CategoryInput.parse({ name, scope }), ...meta() }),
    createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
    createWorkflow: async (x) => ({ ...WorkflowInput.parse(x), ...meta() }),
    updateWorkflow: async (id, input) => {
      wf = { ...WorkflowInput.parse(input), id, createdAt: '', updatedAt: '' }
      return wf
    },
  }
  const w: Workflow = { ...legacy, id: 'bf', createdAt: '', updatedAt: '' }
  const r = await seedProjectWorkflows({ agents: mine, categories: [], tags: [], workflows: [w] }, ops)
  assert.ok(wf, '旧副本被升级')
  const next = r.state.workflows.find((x) => x.id === 'bf')!
  assert.match(next.document, /找到能完整解释现象的原因就修，修完就停/)
  wf = null
  await seedProjectWorkflows({ agents: mine, categories: [], tags: [], workflows: [next] }, ops)
  assert.equal(wf, null, '再启动不再改')
})
