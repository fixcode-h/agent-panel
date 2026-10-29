import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost } from '../shared/engine.ts'
import { composeRole, loadCapability, mountMode, mountedAgents, roleKind } from '../shared/agent-role.ts'
import { INLINE_EDIT_MAX_FILES, inlineEditBlocker, inlineEditOverrun, normInlinePaths } from '../shared/inline-edit.ts'
import { BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
import { CORE_AGENTS, findCore, syncCore } from '../shared/builtin/core.ts'
import { ensureProjectAgents } from '../shared/builtin/install.ts'

/**
 * 角色分层（docs/openspec/changes/role-composition-and-dispatch）：
 * 基本角色 / 高级角色的推导、挂载用法的收紧、能力索引和按需加载、父对话的就地微改动护栏和分诊记录
 */
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
  ...extra,
})

const reviewer = agent('rv', '评审', { modes: ['subtask'], independent: true, when: '独立看一遍改动' })
const tester = agent('ts', '测试验收', {
  instructions: '按 {{scope}} 跑测试。',
  params: [
    {
      key: 'scope',
      label: '范围',
      type: 'select',
      options: ['快速', '全量'],
      default: '全量',
      ask: false,
      description: '',
    },
  ],
})
const docs = agent('dc', '文档', { instructions: '写进文档根。' })
const lead = agent('lead', '主理', {
  canDelegate: true,
  inlineEdit: 'tiny',
  instructions: '你是主理。',
  mounts: [
    { agentId: 'ts', mode: 'inline', preload: false, rule: '快速检查就地', params: { scope: '快速' } },
    { agentId: 'rv', mode: 'auto', preload: false, rule: '', params: {} },
    { agentId: 'dc', mode: 'inline', preload: true, rule: '', params: {} },
  ],
})
const all = [lead, reviewer, tester, docs]

test('角色层：写了 kind 按它，旧数据按能力开关和挂载推导', () => {
  assert.equal(roleKind(agent('a', '甲')), 'basic')
  assert.equal(roleKind(agent('a', '甲', { canDelegate: true })), 'advanced')
  assert.equal(roleKind(agent('a', '甲', { canPlan: true })), 'advanced')
  assert.equal(roleKind(lead), 'advanced')
  assert.equal(roleKind(agent('a', '甲', { canPlan: true, kind: 'basic' })), 'basic')
})

test('挂载用法：超出能力允许的收紧到能用的那种', () => {
  // 评审要独立视角：就地、自动都收成派出
  assert.equal(mountMode('inline', reviewer), 'subtask')
  assert.equal(mountMode('auto', reviewer), 'subtask')
  assert.equal(mountMode('parent', reviewer), 'parent')
  // 只允许就地的能力：派出、转交、自动都收成就地
  const only = agent('o', '只就地', { modes: ['inline'] })
  assert.equal(mountMode('subtask', only), 'inline')
  assert.equal(mountMode('auto', only), 'inline')
  assert.equal(mountMode('auto', tester), 'auto')
  assert.deepEqual(
    mountedAgents(lead, all).map((m) => [m.agent.name, m.mode]),
    [
      ['测试验收', 'inline'],
      ['评审', 'subtask'],
      ['文档', 'inline'],
    ],
  )
})

test('提示词：只放能力索引，常驻加载的才放全文；挂载上的参数取值生效', () => {
  const role = composeRole(lead, all)
  assert.match(role, /## 你挂载的能力/)
  assert.match(role, /\*\*测试验收\*\*/)
  assert.match(role, /use_capability（name 写「测试验收」）/)
  assert.match(role, /spawn_agents 的 agent 写「评审」/)
  assert.match(role, /\*\*评审\*\*：独立看一遍改动/, '索引里写「什么时候用」')
  // 预加载的「文档」全文在提示词里；没预加载的「测试验收」全文不在
  assert.match(role, /## 能力：文档（已加载）\n写进文档根。/)
  assert.doesNotMatch(role, /按 快速 跑测试/)
})

test('use_capability：就地取能力的做法，按挂载参数渲染；只能派出的、没挂载的拒绝', () => {
  const r = loadCapability(lead, all, '测试验收')
  assert.equal(r.ok, true)
  assert.match(r.text, /## 能力：测试验收\n按 快速 跑测试。/)
  // 这次调用给的参数优先于挂载上的
  assert.match(loadCapability(lead, all, '测试验收', {}, {}, { scope: '全量' }).text, /按 全量 跑测试/)
  const rv = loadCapability(lead, all, '评审')
  assert.equal(rv.ok, false)
  assert.match(rv.text, /只能派出：用 spawn_agents/)
  const none = loadCapability(lead, all, '开发')
  assert.equal(none.ok, false)
  assert.match(none.text, /不是你挂载的能力：能用的有/)
})

test('就地微改动护栏：文件数、理由、子对话在合回、文件被占用都拦下', () => {
  const ok = { files: ['a.ts'], reason: '改按钮文案', merging: [], held: [] }
  assert.equal(inlineEditBlocker(ok), '')
  assert.match(inlineEditBlocker({ ...ok, files: [] }), /files 是空的/)
  assert.match(
    inlineEditBlocker({ ...ok, files: Array.from({ length: INLINE_EDIT_MAX_FILES + 1 }, (_, i) => `f${i}`) }),
    /最多改 2 个文件/,
  )
  assert.match(inlineEditBlocker({ ...ok, reason: '' }), /reason 写清/)
  assert.match(inlineEditBlocker({ ...ok, merging: ['登录改造'] }), /「登录改造」正在合回/)
  assert.match(inlineEditBlocker({ ...ok, held: [{ path: 'a.ts', by: '登录改造' }] }), /a\.ts（登录改造）/)
  assert.match(inlineEditBlocker({ ...ok, active: true }), /还没结束/)
  assert.deepEqual(normInlinePaths(['./a/b.ts', 'a\\b.ts', 'dir/', '']), ['a/b.ts', 'dir'])
})

test('就地微改动核对：超出文件数、行数或改了没声明的文件算越界', () => {
  assert.equal(inlineEditOverrun(['a.ts'], [{ path: 'a.ts', add: 3, del: 1 }]).over, false)
  assert.equal(inlineEditOverrun(['src'], [{ path: 'src/a.ts', add: 3, del: 1 }]).over, false, '声明目录覆盖里面的文件')
  const lines = inlineEditOverrun(['a.ts'], [{ path: 'a.ts', add: 30, del: 0 }])
  assert.equal(lines.over, true)
  assert.equal(lines.lines, 30)
  const extra = inlineEditOverrun(
    ['a.ts'],
    [
      { path: 'a.ts', add: 1, del: 1 },
      { path: 'b.ts', add: 1, del: 0 },
    ],
  )
  assert.deepEqual(extra.undeclared, ['b.ts'])
  assert.equal(extra.over, true)
})

function chatHost(task: Task, runAgent: EngineHost['runAgent'], extra: Partial<EngineHost> = {}): EngineHost {
  let n = 0
  return {
    task,
    agents: all,
    workflows: [],
    prompt: '把保存按钮改成「保存设置」',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent,
    ...extra,
  }
}

const parentTask = () =>
  ({
    ...newTask(
      { projectId: 'p', mode: 'chat', agentId: 'lead', prompt: '把保存按钮改成「保存设置」' } as never,
      undefined,
      '',
      'p1',
    ),
    id: 'p1',
  }) as Task

test('父对话：就地微改动走护栏，改动期间不能收尾子对话；分诊记进 routes', async () => {
  const task = parentTask()
  const log: string[] = []
  const h = chatHost(
    task,
    async (call: AgentCall) => {
      const o = call.orch!
      assert.equal(o.inlineEdit, true)
      assert.equal(o.capabilities, true)
      assert.match(call.prompt, /父对话先分析再分派，只就地做微小改动/)
      const r = await o.beginInlineEdit(['web/a.tsx'], '改按钮文案', { understanding: '改一个按钮文案' })
      assert.equal(r.ok, true)
      task.inlineEdit = { files: ['web/a.tsx'], reason: '改按钮文案', startedAt: '', head: '', baseline: {} }
      assert.match((await o.finishChild('c1')).info, /你在就地改动/)
      assert.match((await o.createConversation('另一件事', '做点别的')).info, /就地改动还没结束/)
      assert.equal((await o.endInlineEdit()).ok, true)
      // 设成就地用的能力不派出
      const s = o.spawn([{ title: '跑检查', instructions: '跑快速检查', agent: '测试验收' }])
      assert.match(s.error ?? '', /挂成了就地用：调用 use_capability/)
      return { ok: true, text: '改好了。' }
    },
    {
      inlineEdit: {
        begin: async (files, reason) => {
          log.push(`begin ${files.join(',')} ${reason}`)
          return { ok: true, info: '可以改了' }
        },
        end: async () => {
          log.push('end')
          task.inlineEdit = undefined
          return { ok: true, info: '就地改动结束' }
        },
      },
      finishChild: async () => ({ ok: true, info: '合回了' }),
      createConversation: async () => ({ ok: true, id: 'c2', info: '已新建' }),
    },
  )
  await runEngineTurn(h)
  assert.deepEqual(log, ['begin web/a.tsx 改按钮文案', 'end'])
  assert.equal(task.routes.length, 1)
  assert.equal(task.routes[0].target, 'inline-edit')
  assert.equal(task.routes[0].understanding, '改一个按钮文案')
  assert.equal(task.routes[0].messageId, task.messages.find((m) => m.role === 'user')?.id)
})

test('父对话：角色没开就地改动、或宿主没给护栏时不能就地改，提示词保持「只统筹，不动手」', async () => {
  const task = parentTask()
  const h = chatHost(task, async (call) => {
    assert.equal(call.orch!.inlineEdit, false)
    assert.match(call.prompt, /父对话只统筹，不动手/)
    assert.equal((await call.orch!.beginInlineEdit(['a.ts'], '改文案')).ok, false)
    return { ok: true, text: '交给子对话。' }
  })
  await runEngineTurn(h)
})

test('父对话派子对话：role 只能是启用的高级角色；新开、交回都记分诊', async () => {
  const task = parentTask()
  const worker = agent('wk', '执行', { canPlan: true })
  const made: { agentId?: string }[] = []
  const h = chatHost(
    task,
    async (call) => {
      const o = call.orch!
      const bad = await o.createConversation('导出 PNG', '做导出', [], undefined, { role: '评审' })
      assert.equal(bad.ok, false)
      assert.match(bad.info, /不是可用的高级角色：可以写 「执行」/)
      const good = await o.createConversation('导出 PNG', '做导出', [], undefined, {
        role: '执行',
        route: { reason: '要改代码', assumptions: '导出整张画布' },
      })
      assert.equal(good.ok, true)
      assert.equal((await o.sendToConversation('c9', '补一个用例', undefined, { reason: '验收没过' })).ok, true)
      return { ok: true, text: '已分派。' }
    },
    {
      agents: [...all, worker],
      createConversation: async (input) => {
        made.push({ agentId: input.agentId })
        return { ok: true, id: 'c9', info: '已新建' }
      },
      sendToConversation: async () => ({ ok: true, info: '已交给它' }),
      listConversations: async () => [],
    },
  )
  await runEngineTurn(h)
  assert.deepEqual(made, [{ agentId: 'wk' }])
  assert.deepEqual(
    task.routes.map((r) => [r.target, r.refs[0], r.reason]),
    [
      ['child', 'c9', '要改代码'],
      ['resend', 'c9', '验收没过'],
    ],
  )
  assert.equal(task.routes[0].assumptions, '导出整张画布')
})

test('内置定义：主理、执行、分析是高级角色，挂载装好后换成本机 id；评审只能派出', async () => {
  const def = (k: string) => BUILTIN_AGENTS.find((a) => a.key === k)!
  for (const k of ['orchestrator', 'worker', 'analyzer']) assert.equal(def(k).agent.kind, 'advanced', k)
  assert.equal(def('reviewer').agent.independent, true)
  assert.deepEqual(def('reviewer').agent.modes, ['subtask'])
  assert.equal(def('orchestrator').agent.inlineEdit, 'tiny')
  // 挂载引用的都是存在的内置基本角色
  for (const b of BUILTIN_AGENTS)
    for (const m of b.mounts) {
      const cap = def(m.key)
      assert.ok(cap, `${b.key} 挂了不存在的 ${m.key}`)
      assert.notEqual(cap.agent.kind, 'advanced', `${b.key} 只能挂基本角色，${m.key} 是高级角色`)
    }

  // 装一遍：挂载的 key 换成本机 id，主理默认能就地微改动
  const agents: Agent[] = []
  let n = 0
  const ops = {
    createAgent: async (input: AgentInput) => {
      const a = { ...AgentInput.parse(input), id: `a${++n}`, createdAt: '', updatedAt: '' }
      agents.push(a)
      return a
    },
    updateAgent: async (id: string, input: AgentInput) => {
      const i = agents.findIndex((a) => a.id === id)
      agents[i] = { ...agents[i], ...AgentInput.parse(input) }
      return agents[i]
    },
    createCategory: async (name: string) => ({
      id: `c-${name}`,
      name,
      scope: 'agent' as const,
      order: 0,
      createdAt: '',
      updatedAt: '',
    }),
    createTag: async (x: { name: string }) => ({
      id: `t-${x.name}`,
      name: x.name,
      color: 'violet',
      description: '',
      createdAt: '',
      updatedAt: '',
    }),
  }
  const state = () => ({ agents: [...agents], categories: [], tags: [], workflows: [] })
  await ensureProjectAgents(state() as never, ops as never)
  for (const c of CORE_AGENTS) assert.ok(findCore(agents, c.key), c.key)
  const orch = findCore(agents, 'orchestrator')!
  assert.equal(orch.inlineEdit, 'tiny')
  const names = mountedAgents(orch, agents).map((m) => m.agent.name)
  assert.ok(names.includes('评审') && names.includes('文档') && names.includes('版本控制'), names.join('、'))
  const worker = findCore(agents, 'worker')!
  assert.equal(mountedAgents(worker, agents).find((m) => m.agent.name === '评审')?.mode, 'subtask')
  // 再同步一遍不变（不写盘）
  const again = await ensureProjectAgents(state() as never, ops as never)
  assert.equal(again.synced.length, 0)
})

test('内置角色保存：没接管挂载时跟定义（只留用户的用法和参数取值），接管了（mountsCustom）就整份按用户的', () => {
  const def = BUILTIN_AGENTS.find((a) => a.key === 'worker')!
  const before = [
    { agentId: 'x-explorer', mode: 'auto' as const, preload: false, rule: '定义里的规则', params: {} },
    { agentId: 'x-reviewer', mode: 'subtask' as const, preload: false, rule: '', params: {} },
  ]
  const input = AgentInput.parse({
    ...def.agent,
    mounts: [
      { agentId: 'x-explorer', mode: 'subtask', rule: '用户改的规则', params: { depth: '深' } },
      { agentId: 'x-extra', mode: 'inline' },
    ],
  })
  const next = syncCore(input, def, { categoryId: '', includes: [], mounts: before })
  assert.deepEqual(
    next.mounts.map((m) => [m.agentId, m.mode, m.rule, m.params]),
    [
      ['x-explorer', 'subtask', '定义里的规则', { depth: '深' }],
      ['x-reviewer', 'subtask', '', {}],
    ],
  )
  // 接管后：自己加的挂载、改的说明、删掉的默认挂载都按用户的，再同步也不会被定义改回去
  const mine = AgentInput.parse({ ...input, mountsCustom: true })
  const custom = syncCore(mine, def, { categoryId: '', includes: [], mounts: before })
  assert.deepEqual(
    custom.mounts.map((m) => [m.agentId, m.rule]),
    [
      ['x-explorer', '用户改的规则'],
      ['x-extra', ''],
    ],
  )
  assert.equal(custom.mountsCustom, true)
  // 恢复默认：清掉接管标记就回到定义
  assert.equal(
    syncCore({ ...custom, mountsCustom: false }, def, { categoryId: '', includes: [], mounts: before }).mounts.length,
    2,
  )
})
