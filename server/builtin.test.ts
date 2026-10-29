import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  GENERAL_ORIGIN,
  RETIRED_WORKFLOWS,
} from '../shared/builtin/workflows.ts'
import { BEFORE_TIDY, GENERAL_LEGACY } from '../shared/builtin/legacy-workflows.ts'
import {
  annotateMergedAgents,
  migrateGeneralWorkflow,
  migrateProjectsToGeneral,
  redirectWorkflowRefs,
  retiredWorkflows,
  seedBuiltins,
  seedProjectWorkflows,
  upgradeBuiltinAgents,
  upgradeBuiltinWorkflows,
  workflowFingerprint,
  type BuiltinOps,
} from '../shared/builtin/install.ts'
import {
  ANALYST_BEFORE_SKILL_SPLIT,
  DEVELOPER_BEFORE_SKILL_SPLIT,
  EXPLORER_BEFORE_PROGRESS,
  LEGACY_AGENT_FIELDS,
  LEGACY_AGENT_FIELDS_MORE,
  LEGACY_SCENE_TEXT,
  LEGACY_SCENE_TEXT_SEARCH_SCOPE,
  LEGACY_WORKFLOWS,
  RULES_BEFORE_SEARCH_SCOPE,
  RULES_BEFORE_TURN,
} from '../shared/builtin/legacy.ts'
import { coreDefinition, keepParamValues, upgradeParamDefaults } from '../shared/builtin/core.ts'
import { CategoryInput, TagInput } from '../shared/schema.ts'
import { ensureBundled, installBundled, listBundled, retireBundled } from './bundled-skills.ts'

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

test('「每日工作总结」：只出报告不改代码，需求 / Bug 分开，工作总结页也用它', () => {
  const b = BUILTIN_AGENTS.find((x) => x.key === 'worklog')
  assert.ok(b, '内置角色里有「每日工作总结」')
  assert.equal(b.agent.name, '每日工作总结')
  // 只读：不建计划、不派子任务、不挂通用、不引 Skill（只汇总记录，不需要动手的能力）
  assert.equal(b.agent.canPlan, false, '不启动工作流')
  assert.equal(b.agent.canDelegate, false, '不派子任务')
  assert.equal(b.agent.common, false)
  assert.deepEqual(b.agent.skills, [])
  // 挂进「通用项目」：启动时 ensureProjectAgents 会补建，老用户的角色列表里也能看到
  assert.ok(builtinAgentKeys(GENERAL).includes('worklog'), '挂在「通用项目」上才会在启动时建出来')
  const role = composeRole(agents.find((a) => a.id === 'worklog')!, agents)
  assert.doesNotMatch(role, /\{\{/, '模板都能展开')
  // 范围：只写这段时间里的事，范围外的不写（工作总结页的硬要求）
  assert.match(role, /只算范围内的/)
  assert.match(role, /范围外的对话、消息、报告一律不写/)
  assert.match(role, /本地自然日/)
  // 分类：需求只写做了什么，Bug 写原因和修复；Bug 只收用户自己报的
  assert.match(role, /\*\*需求\*\*/)
  assert.match(role, /只收用户自己报的问题/)
  assert.match(role, /「原因」/)
  assert.match(role, /「修复」/)
  assert.match(role, /描述清楚最重要/)
  // 只写结果：真实跑一次时输出里贴了路径、函数名和接口名
  assert.match(role, /不写具体文件名/)
  assert.match(role, /不编造/)
  // 自己跑（计划面板定时拉起）时读任务记录、有读取预算，输出 Markdown 两节
  assert.match(role, /tasks\/projects\//)
  assert.match(role, /读取预算/)
  assert.match(role, /## 一、需求/)
  assert.match(role, /## 二、Bug/)
  assert.match(role, /只输出报告本身/)
  // 工作总结页调用时选「面板提供」：材料由面板给，不再去读数据目录
  const panel = composeRole(agents.find((a) => a.id === 'worklog')!, agents, { material: '面板提供' })
  assert.match(panel, /材料和范围由面板在下面给出/)
  assert.doesNotMatch(panel, /tasks\/projects\//)
})

test('文档角色：默认勾选「写 Bug 记录」，用户显式关掉的保留', () => {
  const def = coreDefinition('docsync').agent.params.find((p) => p.key === 'bug')!
  assert.equal(def.default, true, '文档角色的「写 Bug 记录」应该默认打开')
  // 启动同步只换参数定义、把用户填的值带过去：显式存过 false 的不被改回 true
  assert.equal(keepParamValues([def], [{ ...def, default: false }])[0].default, false)
  // 没填过值的副本按新默认
  assert.equal(keepParamValues([def], [])[0].default, true)
})

test('文档角色：旧副本存着旧默认（关）的「写 Bug 记录」升级一次改成开，之后用户再关掉的保留', () => {
  const docs = coreDefinition('docsync').agent
  const old = AgentInput.parse({
    ...docs,
    params: docs.params.map((p) => (p.key === 'bug' ? { ...p, default: false } : p)),
  })
  const up = upgradeParamDefaults(old, 'docsync')
  assert.equal(up.params.find((p) => p.key === 'bug')!.default, true)
  assert.deepEqual(up.upgrades, ['docsync.bug-on'])
  // 幂等：再跑一次不变
  assert.deepEqual(upgradeParamDefaults(up, 'docsync'), up)
  // 升级过之后用户关掉：不再改回来
  const off = { ...up, params: up.params.map((p) => (p.key === 'bug' ? { ...p, default: false } : p)) }
  assert.equal(upgradeParamDefaults(off, 'docsync').params.find((p) => p.key === 'bug')!.default, false)
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
  // 整理后的主流程：识别现场与方案 → 实现 → 文档同步，不再有评审、验收和交付节点
  assert.deepEqual(
    main.nodes.map((n) => n.id),
    ['design', 'impl', 'docs'],
  )
  assert.deepEqual(
    next.flows.map((f) => f.id),
    ['main'],
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
  em.nodes.find((n) => n.id === 'design')!.title = '我改过的'
  assert.equal(await migrateGeneralWorkflow(edited, ops), null)
  assert.ok(!GENERAL.flows.find((f) => f.id === 'main')!.nodes.some((n) => n.agent === 'vcs'))
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
    // 详情页要能列出它带哪些文件：树里不含 SKILL.md，目录排在文件前，files 和树里的文件数一致
    assert.ok(one.tree, '自带 Skill 要带文件树')
    assert.equal(
      one.tree.entries.some((x) => x.path.toLowerCase() === 'skill.md'),
      false,
    )
    assert.equal(one.tree.entries.filter((x) => x.type === 'file').length, one.files)
    assert.ok(one.tree.entries.some((x) => x.path === 'scripts' && x.type === 'dir'))
    // 父目录一定排在子项前面（前端的 toTree 依赖这个顺序）
    const at = (p: string) => one.tree!.entries.findIndex((x) => x.path === p)
    assert.ok(at('scripts') < at('scripts/inspect_scene.py'))

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

test('已下线的自带 Skill：和装进去的旧版一致才删，用户改过或加过文件的保留', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'retired-'))
  const root = path.join(home, '.agents/skills')
  const write = (name: string, rel: string, text: string) => {
    mkdirSync(path.join(root, name, path.dirname(rel)), { recursive: true })
    writeFileSync(path.join(root, name, rel), text)
  }
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const retired = {
    'old-a': { 'SKILL.md': sha('老内容'), 'sub/x.md': sha('子文件') },
    'old-b': { 'SKILL.md': sha('老内容 B') },
    'old-c': { 'SKILL.md': sha('老内容 C') },
  }
  try {
    // 没改过：Skill 和子文件都对得上，删掉
    write('old-a', 'SKILL.md', '老内容')
    write('old-a', 'sub/x.md', '子文件')
    // 用户改过：保留
    write('old-b', 'SKILL.md', '用户改过的')
    // 用户自己加过文件：整份保留，不只删认得的那个文件
    write('old-c', 'SKILL.md', '老内容 C')
    write('old-c', 'notes.md', '我加的文件')
    assert.deepEqual(await retireBundled(root, retired), ['old-a'])
    assert.ok(!existsSync(path.join(root, 'old-a')))
    assert.ok(existsSync(path.join(root, 'old-b/SKILL.md')), '改过的保留')
    assert.ok(existsSync(path.join(root, 'old-c/notes.md')), '加过文件的保留')
    // 幂等：再跑一次什么都不删
    assert.deepEqual(await retireBundled(root, retired), [])
  } finally {
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
  // 必备角色「子任务」「分析」不在任何工作流里，由启动时的必备角色检查装上
  assert.equal(
    built.length,
    BUILTIN_AGENTS.filter((b) => b.key !== 'helper' && b.key !== 'analyzer').length,
    '每个内置 Agent 只建一份',
  )
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

  // 用户改过的也换成新版（用户 2026-10-25 定的一律覆盖），覆盖前的交给调用方备份
  const edited = { ...oldTester, id: 'my-tester', description: '我自己改过的说明' }
  const replaced: Agent[] = []
  const again = await upgradeBuiltinAgents({ ...state, agents: [edited] }, ops, (a) => replaced.push(a))
  assert.equal(again[0]?.name, '测试验收')
  assert.deepEqual(replaced, [], '必备角色的设定本来就不能改（保存时也会纠正），不用备份')
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

  // 用户改过的也换成新版，覆盖前的交给调用方备份；没改过的旧版本不用备份
  const edited = { ...old('rules', 'mine'), instructions: `${LEGACY_AGENT_FIELDS.rules.instructions}\n我自己加的一条` }
  const replaced: Agent[] = []
  const again = await upgradeBuiltinAgents({ ...state, agents: [edited] }, ops, (a) => replaced.push(a))
  assert.match(again[0]?.instructions ?? '', /共用工作区/)
  assert.deepEqual(
    replaced.map((a) => a.id),
    ['mine'],
  )
})

test('停在上一版的「通用约束」「代码侦察」也能升级（「代码侦察」现在是「调研」）：补回合推进和派工失败的交付底线', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  // 上一版已经发布过的副本：上一版=现在线上用户手里那份（用具体常量，不用下标：新指纹插在数组前面，[0] 已经不是那一版）
  const prev = (key: 'rules' | 'explorer', id: string) => ({
    ...agents.find((a) => a.id === key)!,
    ...(key === 'rules'
      ? {
          name: '通用约束',
          description: '所有内置 Agent 都引入的常驻规则：语言、编码、提问、执行纪律和安全边界',
          instructions: RULES_BEFORE_TURN,
        }
      : LEGACY_AGENT_FIELDS_MORE.explorer.at(-1)!),
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
    // 引入关系也按定义同步：本机没有「通用约束」时引入是空的
    includes: [],
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

test('上一版的「通用约束」「执行」「版本控制」副本升级：推送归父对话、搜索范围、文档职责收敛', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  // 上一版=现在线上用户手里那份：旧指纹最后一项就是改前的文本
  const prev = (key: 'rules' | 'worker' | 'vcs') => ({
    ...agents.find((a) => a.id === key)!,
    ...LEGACY_AGENT_FIELDS_MORE[key].at(-1)!,
    id: `local-${key}`,
    origin: `builtin:${key}`,
  })
  const state = { agents: [prev('rules'), prev('worker'), prev('vcs')], categories: [], tags: [], workflows: [] }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 3, '三个上一版副本都升级')
  const rules = updated.find((a) => a.name === '通用约束')!
  assert.match(rules.instructions, /## 搜索范围/, '补上大工程的搜索纪律')
  assert.match(rules.instructions, /只由父对话（项目对话）决定/, '对外操作归父对话')
  assert.match(
    rules.instructions,
    /授权推送时默认还包括推送成功后用 GitHub CLI 建 PR 并普通合并到主干/,
    '允许推送时默认收尾包含合并主干，失败就停',
  )
  const worker = updated.find((a) => a.name === '执行')!
  assert.match(worker.instructions, /推送远端、创建 PR、P4 submit、合并到主干由父对话决定/)
  const vcs = updated.find((a) => a.name === '版本控制')!
  assert.match(vcs.instructions, /不改文档/)
  assert.equal(
    vcs.params.some((p) => p.key === 'docs' || p.key === 'bug'),
    false,
    '版本控制角色不再有「同步文档」「写 Bug 记录」两个开关',
  )
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0, '再启动不再改')
})

test('版本控制角色：合并前弄清双方意图、判重、判新旧，合并后补齐并验证；严格度可切', () => {
  const vcs = agents.find((a) => a.id === 'vcs')!
  const review = vcs.params.find((p) => p.key === 'mergeReview')!
  assert.deepEqual(review.options, ['标准', '严格'], '合并审查有两档严格度')
  assert.equal(review.default, '标准', '默认标准：多读几屏提交和 diff、多跑一次受影响范围的检查，不拖慢日常合并')
  const role = composeRole(vcs, agents)
  for (const clause of [
    '先弄清两边为什么这么写',
    'git log --format',
    'docs/lessons/',
    '判重',
    '判新旧',
    '禁止 ours/theirs 整块覆盖',
    '重叠但没冲突的文件同样逐处核对',
    '合并后补齐',
    'typecheck / lint',
    '逐文件核对结果',
  ])
    assert.ok(role.includes(clause), `合并审查条款缺「${clause}」`)
  assert.match(role, /理解不了对方的意图时不要猜/, '理解不清就先别合，不拆掉看着多余的内容')
  assert.doesNotMatch(role, /严格模式/, '标准模式不带严格模式的额外要求')
  const strict = composeRole(vcs, agents, { mergeReview: '严格' })
  assert.match(strict, /严格模式：每个改动过的文件逐条写核对结论/, '严格模式逐文件写结论')
  assert.match(strict, /合并前后各跑一次项目快速检查/, '严格模式合并前后各跑一次检查')
  const submitOnly = composeRole(vcs, agents, { merge: '只提交不合并' })
  assert.doesNotMatch(submitOnly, /合并审查（严格度/, '只提交不合并时不要求合并审查')
})

test('上一版的「通用项目」「UE 项目」副本升级：工作流说明和交付节点的推送措辞跟着改', async () => {
  const mine = agents.map((a) => ({ ...a, origin: `builtin:${a.id}` }))
  const meta = () => ({ id: 'new', createdAt: '', updatedAt: '' })
  const make = async (key: string) => {
    const def = BUILTIN_WORKFLOWS.find((w) => w.key === key)!
    const old = LEGACY_WORKFLOWS[key].at(-1)!
    assert.ok(old.document, `${key} 有旧指纹`)
    return WorkflowInput.parse({
      ...buildWorkflow(
        { ...def, document: old.document, flows: [...old.flows, ...def.flows.filter((f) => f.id !== 'main')] },
        (k) => k,
      ),
      categoryId: 'cat',
      tags: [],
      origin: `builtin:${key}`,
    })
  }
  for (const key of ['project-general', 'project-ue']) {
    let wf: Workflow | null = null
    const ops: BuiltinOps = {
      createAgent: async (a) => ({ ...AgentInput.parse(a), ...meta() }),
      createCategory: async (name) => ({ ...CategoryInput.parse({ name }), ...meta() }),
      createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
      createWorkflow: async (x) => ({ ...WorkflowInput.parse(x), ...meta() }),
      updateWorkflow: async (id, input) => {
        wf = { ...WorkflowInput.parse(input), id, createdAt: '', updatedAt: '' }
        return wf
      },
    }
    const legacy: Workflow = { ...(await make(key)), id: `old-${key}`, createdAt: '', updatedAt: '' }
    await seedProjectWorkflows({ agents: mine, categories: [], tags: [], workflows: [legacy] }, ops)
    assert.ok(wf, `${key} 的旧副本被升级`)
    const next = wf! as Workflow
    assert.match(next.document, /由父对话决定/, `${key} 的工作流说明改成「推送归父对话」`)
    assert.equal((next.document as string).includes('要得到授权'), false)
    wf = null
    await seedProjectWorkflows({ agents: mine, categories: [], tags: [], workflows: [next] }, ops)
    assert.equal(wf, null, `${key} 再启动不再改`)
  }
})

test('调研、子任务、评审三个角色：先读模块地图和模块文档再读代码', () => {
  const text = (key: string) => BUILTIN_AGENTS.find((b) => b.key === key)!.agent.instructions
  // 三个角色共用同一句定位顺序（措辞只有一份），删掉它三处会一起红
  const lookup =
    /先读文档根的 `MODULE-MAP\.md`[\s\S]*?再看文档根下的 `modules\/<模块>\/README\.md`（本项目即 `docs\/modules\/<模块>\/README\.md`）在不在，在就先读/
  for (const [key, who] of [
    ['explorer', '调研'],
    ['helper', '子任务'],
    ['reviewer', '评审'],
  ] as const) {
    assert.match(text(key), lookup, `${who}角色先查模块地图定位模块，有模块文档就先读`)
    assert.match(text(key), /不做无目标的全局搜索/, `${who}角色不无脑全局搜代码`)
    assert.match(text(key), /以代码为准/, `${who}角色文档与实现不一致时以代码为准`)
  }
  // 只读角色不写文档，写文档的三个角色要合并、新建时同步表格行、模块没了删除
  const writers: [string, string, RegExp][] = [
    ['explorer', '调研', /docs\/modules\/<模块>\/README\.md/],
    ['helper', '子任务', /docs\/modules\/<模块>\/README\.md/],
    ['docsync', '文档', /modules\/<模块>\/README\.md/],
  ]
  for (const [key, who, docPath] of writers) {
    const s = text(key)
    assert.match(s, /模块表加一行/, `${who}角色新建模块文档时同步模块表`)
    assert.match(s, docPath, `${who}角色把结论写进对应的模块文档`)
    assert.match(s, /合并/, `${who}角色已有文档时合并，不整文件覆盖`)
    assert.match(s, /已经不存在/, `${who}角色在模块没了时删除文档并同步模块表`)
  }
  assert.match(text('docsync'), /写之前先读/, '文档角色写之前先读模块地图和模块文档')
  // 删模块文档时目录和表格行要一起处理：都删，或都留（状态写 retired），不能只删一边
  assert.match(text('docsync'), /删掉 `modules\/<模块>\/` 整个目录/, '文档角色删掉模块文档目录')
  assert.match(text('docsync'), /模块表删掉那一行/, '文档角色同步删掉模块表那一行')
  assert.match(text('docsync'), /retired/, '文档角色保留迁移线索时表格行也保留')
  // 评审代码改动（ADR 0013）：材料只有交接单和面板附的差异，不读模块文档和 bugs.md；评审方案或结论时才按上面的顺序定位
  assert.match(text('reviewer'), /不读 `MODULE-MAP\.md`、模块文档、`bugs\.md`/, '评审代码不读模块文档')
  assert.match(text('worker'), /docs\/MODULE-MAP\.md/, '执行角色调研模块前先看模块地图和模块文档')
})

test('停在上一版的「调研」也能升级：先查模块地图和模块文档，结论回写', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  // 上一版指纹放在 MORE 数组末尾（见 shared/builtin/legacy.ts）
  const oldExplorer = {
    ...agents.find((a) => a.id === 'explorer')!,
    ...LEGACY_AGENT_FIELDS_MORE.explorer.at(-1)!,
    id: 'local-explorer',
    origin: 'builtin:explorer',
    params: [],
    skills: [],
  }
  const state = { agents: [oldExplorer], categories: [], tags: [], workflows: [] }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 1, '上一版的「调研」副本升级')
  const explorer = updated[0]
  assert.match(explorer.instructions, /先读文档根的/, '调研先查模块地图定位模块')
  assert.match(explorer.instructions, /回写模块文档/, '调研结论回写模块文档')
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0, '再启动不再改')
})

test('停在 2026-10-21 那一版（缺「搜索范围」等四段）的四个副本也能升级', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  // 本机一直停在 2026-10-21，指纹表里没有这一版，所以永远不升级：这里逐字复现当时的副本。
  // name / description 也写当时的值：升级判定是三项全等（见 install.ts 的 upgradeBuiltinAgents）
  const snapshots: [string, string, string, string][] = [
    [
      'rules',
      '通用约束',
      '所有内置 Agent 都引入的常驻规则：语言、编码、提问、执行纪律和安全边界',
      RULES_BEFORE_SEARCH_SCOPE,
    ],
    [
      'explorer',
      '调研',
      '只读调研：定位代码、分析改动影响面、侦察 UE 项目、查官方资料，交回带出处的结论',
      EXPLORER_BEFORE_PROGRESS,
    ],
    [
      'analyst',
      '方案设计',
      '收敛需求、压测方案，出可以确认的设计摘要；影响架构时给出候选方案和带验证方式的架构契约',
      ANALYST_BEFORE_SKILL_SPLIT,
    ],
    [
      'developer',
      '开发',
      '写代码的能力块：按已确认的设计实现，或先找到根因再修 Bug、查性能问题，边改边验证',
      DEVELOPER_BEFORE_SKILL_SPLIT,
    ],
  ]
  const state = {
    agents: snapshots.map(([key, name, description, instructions]) => ({
      ...agents.find((a) => a.id === key)!,
      name,
      description,
      instructions,
      id: `local-${key}`,
      origin: `builtin:${key}`,
      params: [],
      skills: [],
    })),
    categories: [],
    tags: [],
    workflows: [],
  }
  const updated = await upgradeBuiltinAgents(state, ops)
  assert.equal(updated.length, 4, '四个卡住的副本都升级')
  const get = (name: string) => updated.find((a) => a.name === name)!
  assert.match(get('通用约束').instructions, /## 搜索范围/, '补上搜索范围')
  assert.match(get('通用约束').instructions, /## 回合怎么推进/, '补上回合推进')
  assert.match(get('调研').instructions, /## 怎么推进（不要空转）/, '补上不要空转')
  assert.match(get('方案设计').instructions, /ue-project-structure/, '技术栈分支改到新的技能')
  assert.match(get('开发').instructions, /coding-standards/, '补上编码规范技能')
  // 再启动：已经换成新定义，不再改
  assert.equal((await upgradeBuiltinAgents({ ...state, agents: updated }, ops)).length, 0, '再启动不再改')
  // 用户改过的也覆盖（加一行就不再和任何指纹一致），覆盖前的交给调用方备份；没改过的四个不用备份
  const edited = {
    ...state,
    agents: [{ ...state.agents[0], instructions: `${RULES_BEFORE_SEARCH_SCOPE}\n我自己加的一条` }],
  }
  const replaced: Agent[] = []
  assert.equal((await upgradeBuiltinAgents(edited, ops, (a) => replaced.push(a))).length, 1, '改过的也升级')
  assert.deepEqual(
    replaced.map((a) => a.id),
    ['local-rules'],
  )
})

/**
 * 历史指纹里的「识别现场」必须是冻结的正文，不能引用会继续变的 SCENE_TEXT。
 * 引用活的话，SCENE_TEXT 一改，所有指纹会一起变成最新版：原本能匹配上的旧副本永久匹配不上
 * （内置角色卡在旧版升不上来），本来该有区别的几个历史版本也会被抹平成同一份内容。
 * 所以这里断言指纹里的正文是**某一份具体的历史正文**，而不是当前 SCENE_TEXT。
 */
test('历史指纹的「识别现场」是冻结正文，不跟着 SCENE_TEXT 变', () => {
  const all = [...Object.values(LEGACY_AGENT_FIELDS), ...Object.values(LEGACY_AGENT_FIELDS_MORE).flat()].filter(Boolean)
  const withScene = all.filter((f) => f.instructions.includes('识别现场（不改文件）'))
  assert.ok(withScene.length > 0, '指纹表里应该有带「识别现场」的历史角色')
  // 两份冻结正文：10-23 之前那一版，和 10-23 加上「搜索范围」那句之后的那版
  const frozen = [LEGACY_SCENE_TEXT, LEGACY_SCENE_TEXT_SEARCH_SCOPE]
  for (const f of withScene) {
    assert.ok(
      frozen.some((s) => f.instructions.includes(s)),
      `「${f.name}」的指纹里的「识别现场」必须是冻结正文，不能引用 SCENE_TEXT`,
    )
  }
  // 关键：当前 SCENE_TEXT 换了内容时，指纹里那份旧正文不能跟着变。
  // 旧版结尾是「再限定范围搜索。」，新版是「…再限定范围搜（按「搜索范围」的规则带排除，不扫全仓）。」
  assert.ok(
    !LEGACY_SCENE_TEXT.includes('不扫全仓'),
    '10-23 之前那一版不该有「搜索范围」那句；有的话说明它被换成了当前 SCENE_TEXT',
  )
  assert.ok(LEGACY_SCENE_TEXT_SEARCH_SCOPE.includes('不扫全仓'), '10-23 起那一版要带「搜索范围」那句')
  // 两版必须真的不同，否则「按日期选对应的一份」没有意义
  assert.notEqual(LEGACY_SCENE_TEXT, LEGACY_SCENE_TEXT_SEARCH_SCOPE, '两版冻结正文不能是同一份')
  // 逐条绑定：每条指纹该用哪一份「识别现场」。只判断「属于两份之一」拦不住「两份互换」——
  // 把 10-24 写下的 EXPLORER_BEFORE_MODULE_DOC 改回 10-23 之前那一版，集合判断照样通过，
  // 但那条指纹就再也匹配不上 10-24 的旧副本，正是这次要修的那类缺陷。
  const sceneOf = (f: { instructions: string }) =>
    f.instructions.includes(LEGACY_SCENE_TEXT_SEARCH_SCOPE) ? 'search-scope' : 'before-search-scope'
  // explorer 的「调研」有两条、开头逐字相同（只差「识别现场」段），没法靠开头区分，所以单独按条数断言：
  // 10-24 写下的那条必须是 search-scope，另一条必须是 before-search-scope。
  const explorerScene = [LEGACY_AGENT_FIELDS.explorer, ...(LEGACY_AGENT_FIELDS_MORE.explorer ?? [])]
    .filter(Boolean)
    .filter((f) => f.instructions.includes('识别现场（不改文件）'))
  assert.equal(
    explorerScene.filter((f) => sceneOf(f) === 'search-scope').length,
    1,
    'explorer：10-24 那条该用带「搜索范围」那一版',
  )
  assert.equal(
    explorerScene.filter((f) => sceneOf(f) === 'before-search-scope').length,
    1,
    'explorer：10-21 那条该用 10-23 之前那一版',
  )
  // 其余 key：全部是 10-21~10-22 写下的，必须全用 10-23 之前那一版（先确认找到了那条指纹，再断言版本）
  const expectScene: [string, string][] = [
    ['analyst', '你负责把需求收敛成可以确认的设计'],
    ['developer', '{{#if task=实现}}你负责按已确认的设计'],
    ['architect', '你负责架构设计和评审。'],
    ['debugger', '你负责定位并修复问题。没找到根因不修。排查方向'],
    ['uescout', '你负责 Unreal Engine 项目的只读侦察'],
  ]
  for (const [key, head] of expectScene) {
    const hits = [LEGACY_AGENT_FIELDS[key], ...(LEGACY_AGENT_FIELDS_MORE[key] ?? [])]
      .filter(Boolean)
      .filter((f) => f.instructions.replace(/\$\{[A-Z_]+\}/g, '').startsWith(head))
    assert.ok(hits.length, `${key} 的指纹里应该有以这段开头的「识别现场」角色（找不到说明指纹被改过）`)
    for (const f of hits)
      assert.equal(
        sceneOf(f),
        'before-search-scope',
        `${key}「${f.name}」该用 10-23 之前那一版，配错版本会匹配不上当时的旧副本`,
      )
  }
  // 上面都是比对内容，挡不住「某条指纹引用了活的 SCENE_TEXT」：只要当前正文恰好等于某份冻结正文，
  // 内容比对照样通过，等 SCENE_TEXT 下次一改，那条指纹就静默变成最新版了。所以直接看源码。
  const src = readFileSync(path.resolve(import.meta.dirname, '..', 'shared', 'builtin', 'legacy.ts'), 'utf8')
  assert.ok(
    !/\$\{SCENE_TEXT\}/.test(src),
    'legacy.ts 里不能引用活的 SCENE_TEXT：历史指纹要冻结，引用活的话 SCENE_TEXT 一改指纹就跟着变',
  )
})

/**
 * 和上面同一类问题：工作区段（VCS_TEXT）也在 10-23 加过 SVN 分支，历史指纹里引用的必须是当时那一版。
 * 两版各一份冻结副本，不许引用 agents.ts 里会继续变的 VCS_TEXT。
 */
test('历史指纹的工作区段按指纹写下时的版本冻结，不引用活的 VCS_TEXT', () => {
  const all = [...Object.values(LEGACY_AGENT_FIELDS), ...Object.values(LEGACY_AGENT_FIELDS_MORE).flat()].filter(Boolean)
  const withVcs = all.filter((f) => f.instructions.includes('这是 Git 工作区'))
  assert.ok(withVcs.length > 0, '指纹表里应该有带工作区段的角色')
  // 带 SVN 分支的和不带 SVN 分支的各占一部分：早于 10-23 的副本没有 SVN，之后的有
  const withSvn = withVcs.filter((f) => f.instructions.includes('这是 SVN 工作区'))
  const withoutSvn = withVcs.filter((f) => !f.instructions.includes('这是 SVN 工作区'))
  assert.ok(withSvn.length > 0, '10-23 之后写下的指纹应该带 SVN 分支')
  assert.ok(withoutSvn.length > 0, '10-23 之前写下的指纹不该带 SVN 分支')
  // 只看「两种都存在」拦不住「两份互换」：把「评审员」的 VCS_TEXT_BEFORE_SVN 换成带 SVN 的那份，
  // 计数不变、测试照样绿，但那条指纹就再也匹配不上 10-21 的旧副本。所以逐条绑定。
  const vcsOf = (f: { instructions: string }) =>
    f.instructions.includes('这是 SVN 工作区') ? 'with-svn' : 'without-svn'
  const expectVcs: [string, string, string][] = [
    // 10-23 之后写下的：当时已经有 SVN 分支
    ['worker', '你是项目里一个子对话的执行者', 'with-svn'],
    ['vcs', '你负责版本控制与交付收尾', 'with-svn'],
    // 10-22 及更早写下的：当时还没有 SVN 分支
    ['developer', '你负责按已确认的设计（或 tasks.md）实现', 'without-svn'],
    // 10-22 写下的「开发」（带「找 Bug 按模块逐层定位」那版）
    ['developer', '{{#if task=实现}}你负责按已确认的设计', 'without-svn'],
    ['reviewer', '你负责代码评审，不修改文件。', 'without-svn'],
    ['debugger', '你负责定位并修复问题。没找到根因不修。排查方向', 'without-svn'],
    ['vcs', '你负责任务的收尾：', 'without-svn'],
    ['debugger', '你负责定位并修复 Bug。没找到根因不修。', 'without-svn'],
    ['worker', '你是项目里一个子对话的执行者，只负责当前这个任务。', 'with-svn'],
  ]
  for (const [key, head, want] of expectVcs) {
    const hits = [LEGACY_AGENT_FIELDS[key], ...(LEGACY_AGENT_FIELDS_MORE[key] ?? [])]
      .filter(Boolean)
      .filter((f) => f.instructions.replace(/\$\{[A-Z_]+\}/g, '').startsWith(head))
    assert.ok(hits.length, `${key} 的指纹里应该有以这段开头的角色（找不到说明指纹被改过）`)
    for (const f of hits)
      assert.equal(vcsOf(f), want, `${key}「${f.name}」该用 ${want} 那一版工作区段，配错版本会匹配不上当时的旧副本`)
  }
  // 源码层面挡住「改回引用活的 VCS_TEXT」：那种写法会把当前版本拼进所有历史指纹
  const src = readFileSync(path.resolve(import.meta.dirname, '..', 'shared', 'builtin', 'legacy.ts'), 'utf8')
  assert.ok(!/\$\{VCS_TEXT\}/.test(src), 'legacy.ts 里不能引用活的 VCS_TEXT：历史指纹的工作区段要按写下时的版本冻结')
})

/** 测试用的内存 ops：新建的东西按顺序编 id，更新的记下来 */
function memoryOps() {
  let n = 0
  const meta = () => ({ id: `m${++n}`, createdAt: '', updatedAt: '' })
  const updated: Workflow[] = []
  const ops: BuiltinOps = {
    createAgent: async (a) => ({ ...AgentInput.parse(a), ...meta() }),
    createCategory: async (name, scope) => ({ ...CategoryInput.parse({ name, scope }), ...meta() }),
    createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
    createWorkflow: async (w) => ({ ...WorkflowInput.parse(w), ...meta() }),
    updateWorkflow: async (id, input) => {
      const w = { ...WorkflowInput.parse(input), id, createdAt: '', updatedAt: '' }
      updated.push(w)
      return w
    },
  }
  return { ops, updated }
}

test('自带工作流默认全部加入：装过一次的删掉后不再装回来，「通用项目」「UE 项目」缺了就补', async () => {
  const { ops } = memoryOps()
  const empty = { agents: [], categories: [], tags: [], workflows: [] }
  const r = await seedProjectWorkflows(empty, ops)
  assert.deepEqual(
    r.state.workflows.map((w) => w.origin).sort(),
    BUILTIN_WORKFLOWS.map((w) => `builtin:${w.key}`).sort(),
    '第一次启动全部装上',
  )
  assert.deepEqual([...r.seeded].sort(), BUILTIN_WORKFLOWS.map((w) => w.key).sort())
  // 用到的角色随之建好：每个工作流节点都指向本机的角色
  const ids = new Set(r.state.agents.map((a) => a.id))
  for (const w of r.state.workflows)
    for (const f of w.flows)
      for (const nd of f.nodes) for (const s of nodeSteps(nd)) if (s.kind === 'agent') assert.ok(ids.has(s.agentId))
  // 用户删掉「Bug 修复」和「通用项目」：下次启动只补「通用项目」
  const left = r.state.workflows.filter((w) => w.origin !== 'builtin:bugfix' && w.origin !== GENERAL_ORIGIN)
  const r2 = await seedProjectWorkflows({ ...r.state, workflows: left }, ops, r.seeded)
  assert.deepEqual(
    r2.created.map((w) => w.origin),
    [GENERAL_ORIGIN],
  )
  // 以后新加的自带工作流（不在 seeded 里）照样自动装
  const r3 = await seedProjectWorkflows(
    r2.state,
    ops,
    r.seeded.filter((k) => k !== 'bugfix'),
  )
  assert.deepEqual(
    r3.created.map((w) => w.origin),
    ['builtin:bugfix'],
  )
})

test('整理改过的工作流：停在整理前那一版、没改过的副本升级，再启动不再改；没改的不登记旧版', async () => {
  const mine = agents.map((a) => ({ ...a, origin: `builtin:${a.id}` }))
  for (const def of BUILTIN_WORKFLOWS) {
    const legacy = LEGACY_WORKFLOWS[def.key] ?? []
    if (!legacy.length) continue
    // 登记的旧版不能和现在的定义一样，否则每次启动都会重写一遍
    assert.notDeepEqual(legacy.at(-1), { document: def.document, flows: def.flows }, `${def.key} 登记的旧版没变`)
  }
  for (const key of ['project-general', 'project-ue', 'openspec', 'migration', 'bugfix', 'review', 'deps', 'release']) {
    const def = BUILTIN_WORKFLOWS.find((w) => w.key === key)!
    const old = BEFORE_TIDY[key]
    const w: Workflow = {
      ...WorkflowInput.parse({
        ...buildWorkflow({ ...def, document: old.document, flows: old.flows }, (k) => k),
        origin: `builtin:${key}`,
      }),
      id: `old-${key}`,
      createdAt: '',
      updatedAt: '',
    }
    const { ops, updated } = memoryOps()
    const r = await seedProjectWorkflows({ agents: mine, categories: [], tags: [], workflows: [w] }, ops, [
      ...BUILTIN_WORKFLOWS.map((x) => x.key),
    ])
    assert.equal(updated.length, 1, `${key} 的旧副本升级`)
    const next = r.state.workflows.find((x) => x.id === w.id)!
    // 改代码的工作流不再带评审、验收和提交节点
    for (const f of next.flows)
      for (const nd of f.nodes)
        for (const s of nodeSteps(nd)) {
          assert.ok(!s.review || key === 'openspec', `${key}/${nd.title} 还挂着验收流程`)
          if (key !== 'release') assert.notEqual(s.agentId, 'vcs', `${key}/${nd.title} 还有提交节点`)
        }
    const again = memoryOps()
    await seedProjectWorkflows(
      { ...r.state, workflows: [next] },
      again.ops,
      BUILTIN_WORKFLOWS.map((x) => x.key),
    )
    assert.equal(again.updated.length, 0, `${key} 再启动不再改`)
  }
})

test('合并掉的工作流：没改过的副本删掉、项目引用改指到接替的，改过的保留', () => {
  const mine = agents.map((a) => ({ ...a, origin: `builtin:${a.id}` }))
  const make = (key: string, id: string, def = BEFORE_TIDY[key]): Workflow => ({
    ...WorkflowInput.parse({
      name: key,
      mainAgentId: 'developer',
      entryFlowId: 'main',
      document: def.document,
      flows: buildWorkflow({ ...GENERAL, document: def.document, flows: def.flows }, (k) => k).flows,
      origin: `builtin:${key}`,
    }),
    id,
    createdAt: '',
    updatedAt: '',
  })
  const general = make('project-general', 'g', { document: GENERAL.document, flows: GENERAL.flows })
  const ue = make('project-ue', 'u', BEFORE_TIDY['project-ue'])
  const daily = make('daily-dev', 'd')
  const ueDev = make('ue-dev', 'ud')
  const boot = { ...make('bootstrap', 'b'), document: '我改过的说明' }
  const list = retiredWorkflows({ agents: mine, workflows: [general, ue, daily, ueDev, boot] })
  assert.deepEqual(
    list.map((r) => [r.workflow.id, r.into]),
    [
      ['d', 'g'],
      ['ud', 'u'],
    ],
    '没改过的删掉，改过的「项目初始化」保留',
  )
  for (const k of Object.keys(RETIRED_WORKFLOWS)) assert.ok(BEFORE_TIDY[k], `${k} 留了整理前的定义`)

  const project = Project.parse({
    id: 'p',
    name: '项目',
    createdAt: '',
    updatedAt: '',
    workflowId: 'd',
    workflowIds: ['d', 'g', 'b'],
    workflowParams: { d: { docRoot: 'docs' } },
  })
  const other = Project.parse({ id: 'q', name: '别的', createdAt: '', updatedAt: '', workflowId: 'b' })
  const cat = ProjectCategory.parse({ id: 'c', name: '分类', createdAt: '', updatedAt: '', workflowId: 'ud' })
  const refs = redirectWorkflowRefs([project, other], [cat], { d: 'g', ud: 'u' })
  assert.equal(refs.projects.length, 1, '没引用删掉的工作流的项目不动')
  assert.equal(refs.projects[0].workflowId, 'g')
  assert.deepEqual(refs.projects[0].workflowIds, ['g', 'b'], '可选列表去重')
  assert.deepEqual(refs.projects[0].workflowParams, { g: { docRoot: 'docs' } }, '暴露项取值搬过去')
  assert.deepEqual(
    refs.categories.map((c) => c.workflowId),
    ['u'],
  )
})

test('内置工作流按副本上记的指纹判断改没改过：停在没登记的旧版本也能升级，改过的不动，拖动坐标不算改', async () => {
  const w = BUILTIN_WORKFLOWS.find((x) => x.key === 'bugfix') ?? BUILTIN_WORKFLOWS[0]
  const agentId = (key: string) => `id-${key}`
  const state = {
    agents: BUILTIN_AGENTS.map((b) => ({
      ...agents.find((a) => a.id === b.key)!,
      id: `id-${b.key}`,
      origin: `builtin:${b.key}`,
    })),
    categories: [],
    tags: [],
    workflows: [] as Workflow[],
  }
  const saved: Workflow[] = []
  const ops = {
    updateWorkflow: async (id: string, input: WorkflowInput) => {
      const x = { ...WorkflowInput.parse(input), id, createdAt: '', updatedAt: '' } as Workflow
      saved.push(x)
      return x
    },
  } as unknown as BuiltinOps
  // 一个没登记进 LEGACY_WORKFLOWS 的旧版本：文档少一段。面板写它的时候记了指纹
  const built = buildWorkflow(w, agentId)
  const oldInput = {
    ...built,
    name: w.name,
    origin: `builtin:${w.key}`,
    categoryId: '',
    tags: [],
    document: `${built.document}\n旧版多出来的一段`,
  }
  const old = {
    ...WorkflowInput.parse({ ...oldInput, builtinHash: workflowFingerprint(oldInput) }),
    id: 'wf',
    createdAt: '',
    updatedAt: '',
  } as Workflow
  // 用户拖过节点：坐标不算改动
  old.flows[0].nodes[0] = { ...old.flows[0].nodes[0], x: 999, y: 999 }
  const up = await upgradeBuiltinWorkflows({ ...state, workflows: [old] }, ops)
  assert.equal(up.length, 1, '没改过的旧版本升级')
  assert.equal(up[0].document.trim(), built.document.trim())
  assert.equal(up[0].flows[0].nodes[0].x, 999, '坐标沿用本机的')
  assert.equal(up[0].builtinHash, workflowFingerprint(up[0]), '升级后指纹跟着更新')
  // 再启动：已经是当前版本，不再写
  assert.equal((await upgradeBuiltinWorkflows({ ...state, workflows: up }, ops)).length, 0)

  // 用户改过（指纹对不上）：不动
  const edited = { ...old, document: `${old.document}\n我自己加的` }
  assert.equal((await upgradeBuiltinWorkflows({ ...state, workflows: [edited] }, ops)).length, 0)

  // 以前装的、没记过指纹、内容已经是当前版本：补记一次指纹，内容不变
  const { builtinHash: _h, ...noMark } = up[0]
  const marked = await upgradeBuiltinWorkflows({ ...state, workflows: [noMark as Workflow] }, ops)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].builtinHash, workflowFingerprint(up[0]))
  assert.equal(marked[0].document, up[0].document)
})
