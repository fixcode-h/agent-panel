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
} from '../shared/builtin/workflows.ts'
import {
  annotateMergedAgents,
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
  assert.ok(skillDirs.length >= 12)
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
  // 除了「通用约束」自己，Agent 角色都引入了它；Chat 角色（ADR 0038）只引入 Chat 角色，能力全关
  for (const a of agents.filter((x) => x.id !== 'rules' && x.scope !== 'chat'))
    assert.ok(a.includes.includes('rules'), a.name)
  for (const b of BUILTIN_AGENTS.filter((x) => x.agent.scope === 'chat')) {
    const { common, canDelegate, canPlan } = b.agent
    assert.deepEqual([common, canDelegate, canPlan, b.mounts.length], [false, false, false, 0], b.agent.name)
    for (const k of b.includes) assert.equal(BUILTIN_AGENTS.find((x) => x.key === k)?.agent.scope, 'chat', k)
  }
})

test('「每日工作总结」：只出报告不改代码，需求 / 问题分开、像人写的日报，工作总结页也用它', () => {
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
  const role = composeRole(
    agents.find((a) => a.id === 'worklog')!,
    agents,
  )
  assert.doesNotMatch(role, /\{\{/, '模板都能展开')
  // 范围：只写这段时间里的事，范围外的不写（工作总结页的硬要求）
  assert.match(role, /只算范围内的/)
  assert.match(role, /范围外的对话、消息、报告一律不写/)
  assert.match(role, /本地自然日/)
  // 分类：需求和问题两类；问题只收用户自己报的
  assert.match(role, /\*\*需求\*\*/)
  assert.match(role, /只收用户自己报的问题/)
  // 写法（ADR 0056 取代 ADR 0043 的一段话写法）：有几项就分几点；问题分原因和修复，没解决不写修复；
  // 修好的问题附带注释的关键代码，只抄真实改动；去掉 AI 腔
  assert.match(role, /像自己写给组长的日报/)
  assert.match(role, /有几项的内容就分几点写/)
  assert.match(role, /还没解决就不写修复/)
  assert.match(role, /关键代码（code）：只给已经解决的问题/)
  assert.match(role, /不改写、不补全、不编/)
  assert.match(role, /「实现了」「优化了」/, '列出不许用的 AI 说法')
  // 版本管理操作不写（用户嫌报告里全是提交、合并这些）；测试过没过这类也不写
  assert.match(role, /版本管理操作：/)
  assert.match(role, /cherry-pick/)
  assert.match(role, /测试过没过/)
  // 只写结果：真实跑一次时输出里贴了路径、函数名和接口名；代码只放在关键代码里
  assert.match(role, /不写文件名、函数名、命令/)
  assert.match(role, /不编造/)
  // 自己跑（计划面板定时拉起）时读任务记录、有读取预算，关键代码从 git 只读取；输出 Markdown 两节，条目是三级标题、内容分点
  assert.match(role, /tasks\/projects\//)
  assert.match(role, /读取预算/)
  assert.match(role, /## 需求/)
  assert.match(role, /## 问题/)
  assert.match(role, /git diff <from> <to>/)
  assert.match(role, /### 1\. <标题>/)
  assert.match(role, /\*\*原因\*\*/)
  assert.match(role, /只输出报告本身/)
  // 工作总结页调用时选「面板提供」：材料由面板给，不再去读数据目录
  const panel = composeRole(
    agents.find((a) => a.id === 'worklog')!,
    agents,
    { material: '面板提供' },
  )
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

test('协调器：汇报默认详细，旧副本的「精简」升级一次，之后用户再选精简的保留', () => {
  const orch = coreDefinition('orchestrator').agent
  assert.equal(orch.params.find((p) => p.key === 'report')!.default, '详细', '协调器的汇报应该默认详细')
  const old = AgentInput.parse({
    ...orch,
    params: orch.params.map((p) => (p.key === 'report' ? { ...p, default: '精简' } : p)),
    // 大改动先确认那条已经做过，只看汇报这一条
    upgrades: ['orchestrator.confirm-on'],
  })
  const up = upgradeParamDefaults(old, 'orchestrator')
  assert.equal(up.params.find((p) => p.key === 'report')!.default, '详细')
  assert.deepEqual(up.upgrades, ['orchestrator.confirm-on', 'orchestrator.report-detailed'])
  assert.deepEqual(upgradeParamDefaults(up, 'orchestrator'), up)
  const brief = { ...up, params: up.params.map((p) => (p.key === 'report' ? { ...p, default: '精简' } : p)) }
  assert.equal(upgradeParamDefaults(brief, 'orchestrator').params.find((p) => p.key === 'report')!.default, '精简')
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

test('自带 Skill：统一装到 ~/.agents/skills，已有的不覆盖，执行前自动补齐缺的', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bundled-'))
  const old = { ...process.env }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const list = await listBundled()
    assert.equal(list.length, skillDirs.length)
    assert.ok(list.every((s) => s.status.shared === 'missing'))
    const one = list.find((s) => s.name === 'task-records')!
    assert.ok(one.files >= 4, '带上了模板')
    // 详情页要能列出它带哪些文件：树里不含 SKILL.md，目录排在文件前，files 和树里的文件数一致
    assert.ok(one.tree, '自带 Skill 要带文件树')
    assert.equal(
      one.tree.entries.some((x) => x.path.toLowerCase() === 'skill.md'),
      false,
    )
    assert.equal(one.tree.entries.filter((x) => x.type === 'file').length, one.files)
    assert.ok(one.tree.entries.some((x) => x.path === 'templates' && x.type === 'dir'))
    // 父目录一定排在子项前面（前端的 toTree 依赖这个顺序）
    const at = (p: string) => one.tree!.entries.findIndex((x) => x.path === p)
    assert.ok(at('templates') < at('templates/design.md'))

    const r = await installBundled(['task-records'], [], false)
    assert.deepEqual(r.done, ['task-records'])
    const dir = path.join(home, '.agents/skills/task-records')
    assert.ok(existsSync(path.join(dir, 'SKILL.md')))
    assert.ok(existsSync(path.join(dir, 'templates/design.md')))
    assert.equal((await listBundled()).find((s) => s.name === 'task-records')!.status.shared, 'same')

    // 用户改过的：不覆盖，状态是「不同」；明确覆盖时换回自带的
    writeFileSync(path.join(dir, 'SKILL.md'), '改过')
    assert.equal((await listBundled()).find((s) => s.name === 'task-records')!.status.shared, 'changed')
    assert.deepEqual((await installBundled(['task-records'], [], false)).skipped, ['task-records'])
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')
    await installBundled(['task-records'], [], true)
    assert.notEqual(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')

    // 执行前补齐：只装缺的、只装自带的，用户的同名 Skill 不动
    writeFileSync(path.join(dir, 'SKILL.md'), '用户的')
    const added = await ensureBundled(['task-records', 'grilling', '不存在的'])
    assert.deepEqual(added, ['grilling'])
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '用户的')
  } finally {
    // 按键还原：process.env = old 会换成普通对象，之后再设 HOME，os.homedir() 读不到（rules-check 第 17 条）
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]
    Object.assign(process.env, old)
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
  // 必备角色「子任务」「排查分析」「助手」（连同它引入的「聊天约束」）不在任何工作流里，由启动时的必备角色检查装上
  const notInFlows = ['helper', 'analyzer', 'chat', 'chat-rules']
  assert.equal(
    built.length,
    BUILTIN_AGENTS.filter((b) => !notInFlows.includes(b.key)).length,
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
  // 模块文档只有「文档」一个出口（ADR 0048）：调研、子任务不自己写，要点交回；文档角色合并已有的、模块没了删目录，模块表是生成物
  for (const [key, who] of [
    ['explorer', '调研'],
    ['helper', '子任务'],
  ] as const) {
    assert.match(
      text(key),
      /不要自己写文档：在结果里单列一节「建议补模块文档」/,
      `${who}角色读明白的模块要点交回，不自己写`,
    )
    assert.doesNotMatch(text(key), /模块表加一行/, `${who}角色不改模块表`)
  }
  const doc = text('docsync')
  assert.match(doc, /模块文档只有一个出口，就是你/)
  assert.match(doc, /写之前先读 `modules\/<模块>\/README\.md`/, '文档角色写之前先读模块文档')
  assert.match(doc, /合并时只改对应小节/, '已有文档时合并，不整文件覆盖')
  assert.match(doc, /删掉 `modules\/<模块>\/` 整个目录/, '模块没了删掉模块文档目录')
  assert.match(doc, /不要手写、手改模块表，地图不存在也不要建/, '模块表不手改、不自己建')
  assert.doesNotMatch(doc, /retired/, '不留墓碑目录')
  // 评审代码改动（ADR 0013）：材料只有交接单和面板附的差异，不读模块文档和 bugs.md；评审方案或结论时才按上面的顺序定位
  assert.match(text('reviewer'), /不读 `MODULE-MAP\.md`、模块文档、`bugs\.md`/, '评审代码不读模块文档')
  assert.match(text('worker'), /docs\/MODULE-MAP\.md/, '执行角色调研模块前先看模块地图和模块文档')
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
  // 用户删掉「代码评审」和「通用项目」：下次启动只补「通用项目」
  const left = r.state.workflows.filter((w) => w.origin !== 'builtin:review' && w.origin !== GENERAL_ORIGIN)
  const r2 = await seedProjectWorkflows({ ...r.state, workflows: left }, ops, r.seeded)
  assert.deepEqual(
    r2.created.map((w) => w.origin),
    [GENERAL_ORIGIN],
  )
  // 以后新加的自带工作流（不在 seeded 里）照样自动装
  const r3 = await seedProjectWorkflows(
    r2.state,
    ops,
    r.seeded.filter((k) => k !== 'review'),
  )
  assert.deepEqual(
    r3.created.map((w) => w.origin),
    ['builtin:review'],
  )
})

test('内置工作流：定义更新了就覆盖本机副本（改过的也覆盖），定义没变时用户改的留着，拖动坐标不算改', async () => {
  const w = BUILTIN_WORKFLOWS[0]
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
  const ops = {
    updateWorkflow: async (id: string, input: WorkflowInput) =>
      ({ ...WorkflowInput.parse(input), id, createdAt: '', updatedAt: '' }) as Workflow,
  } as unknown as BuiltinOps
  // 上一版定义写出来的副本（文档多一段），之后用户又改过一处：定义更新了，照样覆盖成新版（用户 2026-11-12 定的）
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
  old.flows[0].nodes[0] = { ...old.flows[0].nodes[0], x: 999, y: 999 }
  const edited = { ...old, document: `${old.document}\n我自己加的` }
  const up = await upgradeBuiltinWorkflows({ ...state, workflows: [edited] }, ops)
  assert.equal(up.length, 1, '改过的也覆盖')
  assert.equal(up[0].document.trim(), built.document.trim())
  assert.equal(up[0].flows[0].nodes[0].x, 999, '坐标沿用本机的')
  assert.equal(up[0].builtinHash, workflowFingerprint(up[0]), '指纹记成新版')
  assert.equal((await upgradeBuiltinWorkflows({ ...state, workflows: up }, ops)).length, 0, '再启动不再写')

  // 定义没变：用户在新版上改的留着
  const mine = { ...up[0], document: `${up[0].document}\n升级后我又改的` }
  assert.equal((await upgradeBuiltinWorkflows({ ...state, workflows: [mine] }, ops)).length, 0)

  // 没记过指纹的老副本：认不出是哪一版，覆盖成新版并记上指纹
  const { builtinHash: _h, ...noMark } = edited
  const marked = await upgradeBuiltinWorkflows({ ...state, workflows: [noMark as Workflow] }, ops)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].builtinHash, workflowFingerprint(marked[0]))
})

test('合并掉的工作流：记过指纹且没改过的删掉、项目引用改指到接替的；改过的和没指纹的老副本保留', () => {
  const mine = agents.map((a) => ({ ...a, origin: `builtin:${a.id}` }))
  const make = (key: string, id: string, document = `${key} 的说明`): Workflow => {
    const input = WorkflowInput.parse({
      name: key,
      mainAgentId: 'developer',
      entryFlowId: 'main',
      document,
      flows: buildWorkflow(GENERAL, (k) => k).flows,
      origin: `builtin:${key}`,
    })
    return { ...input, builtinHash: workflowFingerprint(input), id, createdAt: '', updatedAt: '' }
  }
  const general = make('project-general', 'g')
  const ue = make('project-ue', 'u')
  const daily = make('daily-dev', 'd')
  const ueDev = make('ue-dev', 'ud')
  const boot = { ...make('bootstrap', 'b'), document: '我改过的说明' }
  const { builtinHash: _h, ...bugOld } = make('bugfix', 'bf')
  const list = retiredWorkflows({ agents: mine, workflows: [general, ue, daily, ueDev, boot, bugOld as Workflow] })
  assert.deepEqual(
    list.map((r) => [r.workflow.id, r.into]),
    [
      ['d', 'g'],
      ['ud', 'u'],
    ],
    '没改过的删掉；改过的「项目初始化」、没指纹的「Bug 修复」保留',
  )
  assert.ok(!BUILTIN_WORKFLOWS.some((w) => w.key === 'bugfix'), '不再装「Bug 修复」')

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

test('内置角色：本机改过的设定按当前定义直接覆盖，参数取值留着，再启动不再改', async () => {
  const saved: Agent[] = []
  const ops = {
    async updateAgent(id: string, input: AgentInput) {
      saved.push({ ...AgentInput.parse(input), id, createdAt: '', updatedAt: '' })
      return saved.at(-1)!
    },
  }
  const def = agents.find((a) => a.id === 'developer')!
  const edited = {
    ...def,
    id: 'local-dev',
    origin: 'builtin:developer',
    instructions: `${def.instructions}\n我自己加的一条`,
  }
  const st = { agents: [edited], categories: [], tags: [], workflows: [] }
  const up = await upgradeBuiltinAgents(st, ops)
  assert.equal(up.length, 1, '改过的也覆盖')
  assert.equal(up[0].instructions.trim(), def.instructions.trim())
  assert.equal((await upgradeBuiltinAgents({ ...st, agents: up }, ops)).length, 0, '再启动不再改')
})
