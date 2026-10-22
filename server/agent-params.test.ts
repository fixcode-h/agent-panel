import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, AgentInput, Project, ProjectInput, TestStep, Workflow, WorkflowInput } from '../shared/schema.ts'
import {
  agentParamGroups,
  derivedParams,
  isDefaultValue,
  projectAgentValues,
  workflowAgentIds,
} from '../shared/agent-params.ts'
import { applyExpose } from '../shared/expose.ts'
import { taskSnapshot } from '../shared/builtin/default.ts'
import { defaultTestSteps, isTestAgent, stepCommand, testStepsBlock, testStepIssues } from '../shared/test-steps.ts'
import { buildAssistPrompt, resolveParamValues, resolveTestSteps } from '../shared/assist.ts'
import { BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
import { BUILTIN_WORKFLOWS, builtinAgentKeys } from '../shared/builtin/workflows.ts'
import { MERGED_AGENTS } from '../shared/builtin/legacy.ts'
import { redirectMergedWorkflows } from '../shared/builtin/install.ts'

/**
 * 项目设置里按工作流派生 Agent 参数：同 key 合并、默认值、expose 优先、快照不随设置变化。
 */

const agent = (id: string, params: unknown[], extra: Partial<AgentInput> = {}): Agent => ({
  ...AgentInput.parse({ name: id, params, ...extra }),
  id,
  createdAt: '',
  updatedAt: '',
})

const tester = agent('tester', [
  {
    key: 'scope',
    label: '范围',
    type: 'select',
    options: ['本次改动', '整体'],
    default: '本次改动',
  },
  { key: 'env', label: '环境', type: 'select', options: ['自动', 'wsl', 'powershell', 'bash'], default: '自动' },
  { key: 'regress', label: '查回归', type: 'bool', default: true },
  { key: 'serial', label: '串行执行', type: 'bool', default: false },
])

/** 开发者也声明了 scope，但选项一样：同一个 key 应该只出现一次并注明影响两个 Agent */
const developer = agent('dev', [
  { key: 'scope', label: '范围', type: 'select', options: ['本次改动', '整体'], default: '本次改动' },
  { key: 'lang', label: '语言', type: 'select', options: ['ts', '多种'], default: 'ts' },
])

const workflow = (o: { expose?: unknown[]; mainAgentId?: string } = {}) =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '工作流',
    mainAgentId: o.mainAgentId ?? 'dev',
    document: '说明',
    expose: o.expose ?? [],
    flows: [
      {
        id: 'main',
        nodes: [
          {
            id: 'n1',
            title: '实现',
            agentId: 'dev',
            params: {},
          },
          {
            id: 'n2',
            title: '测试',
            // 步骤上选 Agent 也要算进来
            steps: [{ id: 'st1', title: '跑测试', kind: 'agent', agentId: 'tester', params: {} }],
          },
          // 没指定 Agent 的节点由主 Agent 执行
          { id: 'n3', title: '整理', agentId: '', params: {} },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'n1' },
          { id: 'e2', from: 'n1', to: 'n2' },
          { id: 'e3', from: 'n2', to: 'n3' },
          { id: 'e4', from: 'n3', to: 'end' },
        ],
      },
    ],
  })

const agents = [tester, developer]

test('派生的参数覆盖主 Agent、节点和步骤里的 Agent，去重', () => {
  const w = workflow()
  assert.deepEqual(workflowAgentIds(w).sort(), ['dev', 'tester'])
  const groups = agentParamGroups(w, agents)
  // 主 Agent 排在最前
  assert.equal(groups[0].agentId, 'dev')
  assert.deepEqual(
    groups.map((g) => g.agentName),
    ['dev', 'tester'],
  )
})

test('同一个 key 只出现一次，记下影响哪些 Agent，不静默取第一个', () => {
  const w = workflow()
  const list = derivedParams(w, agents)
  const scope = list.filter((d) => d.key === 'scope')
  assert.equal(scope.length, 1)
  assert.deepEqual(scope[0].agents.map((a) => a.name).sort(), ['dev', 'tester'])
  const keys = list.map((d) => d.key)
  assert.equal(new Set(keys).size, keys.length)
  // 每个 Agent 独有的参数也在
  assert.ok(keys.includes('env'))
  assert.ok(keys.includes('lang'))
})

test('默认值来自 AgentParam.default，没有默认值又要求填的标成必须填', () => {
  const strict = agent('strict', [
    { key: 'branch', label: '分支', type: 'text', ask: true },
    { key: 'level', label: '级别', type: 'number', default: 2 },
  ])
  const w = Workflow.parse({
    ...workflow(),
    flows: [
      {
        id: 'main',
        nodes: [{ id: 'n1', title: '做', agentId: 'strict', params: {} }],
        edges: [{ id: 'e1', from: 'start', to: 'n1' }],
      },
    ],
  })
  const list = derivedParams(w, [...agents, strict])
  assert.equal(list.find((d) => d.key === 'level')!.defaultValue, 2)
  assert.equal(list.find((d) => d.key === 'branch')!.required, true)
  assert.equal(isDefaultValue(list.find((d) => d.key === 'level')!, 2), true, '和默认值相同时算没填过')
  assert.equal(isDefaultValue(list.find((d) => d.key === 'level')!, 5), false)
  assert.equal(isDefaultValue(list.find((d) => d.key === 'level')!, undefined), true)
})

test('工作流 expose 已经管着的 key 不再派生，同一参数不会有两套配置源', () => {
  const w = workflow({
    expose: [{ key: 'regress', label: '查回归', type: 'bool', target: 'agent', targetId: 'regress' }],
  })
  assert.equal(
    derivedParams(w, agents).some((d) => d.key === 'regress'),
    false,
  )
})

test('项目值只保留填过的，空字符串和空多选当没填', () => {
  const w = workflow()
  const values = projectAgentValues(w, agents, { scope: '整体', env: '', regress: false, lang: 'ts' })
  assert.equal(values.scope, '整体')
  assert.equal(values.regress, false, 'false 是有效值')
  assert.equal('env' in values, false)
  assert.equal(values.lang, 'ts')
})

test('项目值按 Agent 声明落到节点和步骤上：声明了才写，节点自己的值被项目值覆盖', () => {
  const w = workflow()
  const out = applyExpose(w, { scope: '整体', regress: false }, agents)
  const n1 = out.flows[0].nodes[0]
  assert.equal(n1.params.scope, '整体')
  // dev 没有声明 regress：不写进去，不会把无关参数塞进节点
  assert.equal('regress' in n1.params, false)
  const step = out.flows[0].nodes[1].steps[0]
  assert.equal(step.params.scope, '整体')
  assert.equal(step.params.regress, false)
  // 没指定 Agent 的节点按主 Agent 处理（dev 也没声明 regress）
  assert.equal(out.flows[0].nodes[2].params.scope, '整体')
})

test('节点上原来的值被项目值覆盖，项目没填的保留', () => {
  const w = Workflow.parse({
    ...workflow(),
    flows: [
      {
        id: 'main',
        nodes: [{ id: 'n1', title: '做', agentId: 'tester', params: { regress: true, serial: true } }],
        edges: [{ id: 'e1', from: 'start', to: 'n1' }],
      },
    ],
  })
  const out = applyExpose(w, { regress: false }, agents)
  assert.equal(out.flows[0].nodes[0].params.regress, false)
  assert.equal(out.flows[0].nodes[0].params.serial, true, '项目没填的用节点自己的值')
})

test('expose（target=agent）覆盖同名的项目值：expose 更具体', () => {
  const w = workflow({
    expose: [{ key: 'regress', label: '查回归', type: 'bool', target: 'agent', targetId: 'regress' }],
  })
  const out = applyExpose(w, { regress: true, scope: '整体' }, agents)
  const step = out.flows[0].nodes[1].steps[0]
  assert.equal(step.params.regress, true, 'expose 的值最后写入')
  assert.equal(step.params.scope, '整体')
})

test('快照在新建对话时定下来：之后改项目设置不影响已经生成的快照', () => {
  const w = workflow()
  const params = { scope: '整体' }
  const snap = taskSnapshot(w, [w], params, {
    agents,
    testSteps: defaultTestSteps('node', { windows: true, scripts: { typecheck: 'tsc' } }),
    platform: 'win32',
  })
  params.scope = '本次改动'
  const step = snap[0].flows[0].nodes[1].steps[0]
  assert.equal(step.params.scope, '整体')
  // 测试步骤也写进了工作流说明（快照），之后改项目设置不会再影响
  assert.match(snap[0].document, /## 项目测试步骤/)
  assert.match(snap[0].document, /npm run typecheck/)
})

test('没用测试 Agent 的工作流不注入测试步骤，免得评审、建模也看到一份无关的命令', () => {
  const w = Workflow.parse({
    ...workflow(),
    flows: [
      {
        id: 'main',
        nodes: [{ id: 'n1', title: '评审', agentId: 'dev', params: {} }],
        edges: [{ id: 'e1', from: 'start', to: 'n1' }],
      },
    ],
  })
  const snap = taskSnapshot(
    w,
    [w],
    {},
    { agents, testSteps: defaultTestSteps('node', { windows: true }), platform: 'win32' },
  )
  assert.doesNotMatch(snap[0].document, /## 项目测试步骤/)
})

test('重复生成快照不会叠加测试步骤那一段', () => {
  const w = workflow()
  const opts = {
    agents,
    testSteps: defaultTestSteps('node', { windows: true, scripts: { build: 'vite build' } }),
    platform: 'win32',
  }
  const once = taskSnapshot(w, [w], {}, opts)
  const again = taskSnapshot(once[0], [once[0]], {}, opts)
  const count = again[0].document.split('## 项目测试步骤').length - 1
  assert.equal(count, 1)
})

// ---- 测试步骤本身 ----

test('测试步骤的 zod 校验：名称和命令必填，旧项目没有这个字段时是空数组', () => {
  const p = Project.parse({ id: 'p', name: '项目', createdAt: '', updatedAt: '' })
  assert.deepEqual(p.testSteps, [])
  assert.equal(p.wslDistro, '')
  const ok = ProjectInput.parse({
    name: '项目',
    testSteps: [{ id: 'a', name: '类型检查', command: 'npm run typecheck', env: 'auto' }],
  })
  assert.equal(ok.testSteps.length, 1)
  assert.equal(ok.testSteps[0].enabled, true)
  assert.equal(ok.testSteps[0].timeoutSec, 0)
  const bad = ProjectInput.safeParse({ name: '项目', testSteps: [{ id: 'a', name: '', command: '' }] })
  assert.equal(bad.success, false)
  // 不认识的环境退回 auto，不会把整份项目读坏
  const weird = ProjectInput.parse({
    name: '项目',
    testSteps: [{ id: 'a', name: 'x', command: 'y', env: 'fish' }],
  })
  assert.equal(weird.testSteps[0].env, 'auto')
})

test('步骤的校验函数逐条指出问题', () => {
  const issues = testStepIssues([
    { name: '', command: 'x', env: 'auto' },
    { name: 'b', command: ' ', env: 'auto' },
    { name: 'c', command: 'y', env: 'nope' as TestStep['env'] },
  ])
  assert.equal(issues.length, 3)
})

test('命令按环境写成真的能执行的形式：WSL 用 wsl.exe，非 Windows 降级成 bash', () => {
  assert.match(
    stepCommand({ command: 'npm run test:e2e', env: 'wsl' }, 'win32', 'Ubuntu-24.04'),
    /^wsl\.exe -d Ubuntu-24\.04 -- bash -lc "/,
  )
  assert.match(stepCommand({ command: 'npm run test:e2e', env: 'wsl' }, 'win32'), /Ubuntu-24\.04/)
  assert.match(stepCommand({ command: 'npm test', env: 'wsl' }, 'linux'), /^bash -lc "/)
  assert.match(stepCommand({ command: 'dir', env: 'powershell' }, 'win32'), /^powershell -NoProfile -Command "/)
  assert.match(stepCommand({ command: 'dir', env: 'cmd' }, 'win32'), /^cmd\.exe \/d \/c "/)
  assert.equal(stepCommand({ command: 'cargo test', env: 'auto' }, 'linux'), 'cargo test')
})

test('项目没配置步骤时的兜底：让 Agent 自己找命令并建议补上，不编命令', () => {
  const text = testStepsBlock([], 'win32')
  assert.match(text, /项目还没有配置测试步骤/)
  assert.match(text, /不要编命令/)
  assert.match(text, /建议在项目设置里补上/)
})

test('默认步骤按技术栈给：Node 只列项目里真的有的 scripts，UE 给 Build.bat', () => {
  const node = defaultTestSteps('node', {
    windows: true,
    scripts: { typecheck: 'tsc', lint: 'oxlint', 'test:unit': 'tsx', 'test:e2e': 'node e2e', build: 'vite build' },
  })
  assert.deepEqual(
    node.map((s) => s.id),
    ['node-typecheck', 'node-lint', 'node-unit', 'node-e2e', 'node-build'],
  )
  // Windows 上 e2e 标成 WSL
  assert.equal(node.find((s) => s.id === 'node-e2e')!.env, 'wsl')
  const empty = defaultTestSteps('node', { windows: true, scripts: {} })
  assert.deepEqual(empty, [])
  const ue = defaultTestSteps('ue', { windows: true })
  assert.match(ue[0].command, /Build\.bat .* -WaitMutex/)
  assert.equal(ue[0].env, 'cmd')
})

// ---- AI 结果校验 ----

test('AI 给的参数值按类型校验：不在选项里、类型不对都要指出', () => {
  const spec = derivedParams(workflow(), agents)
  const ok = resolveParamValues({ values: { scope: '整体', regress: false, lang: 'ts' } }, spec)
  assert.deepEqual(ok.values, { scope: '整体', regress: false, lang: 'ts' })
  const wrong = resolveParamValues({ values: { scope: '随便', regress: '是', 不存在的: 1 } }, spec)
  assert.match(wrong.error!, /scope/)
  assert.match(wrong.error!, /regress/)
  assert.match(wrong.error!, /不存在的/)
  assert.equal(wrong.values, undefined)
  const notObject = resolveParamValues('nope', spec)
  assert.ok(notObject.error)
})

test('AI 给的测试步骤：字段校验、id 自动去重，空列表要报错', () => {
  const r = resolveTestSteps({
    steps: [
      { id: 'x', name: '类型检查', command: 'npm run typecheck', env: 'auto' },
      { id: 'x', name: '单元测试', command: 'npm run test:unit' },
    ],
  })
  assert.equal(r.steps!.length, 2)
  assert.notEqual(r.steps![0].id, r.steps![1].id)
  assert.equal(r.steps![1].env, 'auto')
  assert.match(resolveTestSteps({ steps: [] }).error!, /至少/)
  assert.ok(resolveTestSteps({ steps: [{ name: '', command: 'x' }] }).error)
  assert.ok(resolveTestSteps({ steps: [{ name: 'a', command: 'x', env: 'fish' }] }).error)
})

// ---- 内置 Agent / 工作流的整体整理 ----

test('能力块不重复：通用 Agent 里只有一个负责跑测试，已合并的 key 不再出现在内置定义里', () => {
  // 按「范围 + 环境」两个参数认测试 Agent：两个都声明就是跑测试的
  const testers = BUILTIN_AGENTS.filter((b) => b.agent.common && isTestAgent({ params: b.agent.params }))
  assert.deepEqual(
    testers.map((b) => b.key),
    ['tester'],
    '通用 Agent 里只能有一个测试与验收',
  )
  // 合并掉的旧 key 不能再作为内置 Agent 出现，否则又会被装一份出来
  for (const key of Object.keys(MERGED_AGENTS)) assert.ok(!BUILTIN_AGENTS.some((b) => b.key === key), key)
  // 所有内置 Agent 的 key 唯一，且工作流用得到的都能找到
  assert.equal(new Set(BUILTIN_AGENTS.map((b) => b.key)).size, BUILTIN_AGENTS.length)
})

test('内置工作流不引用不存在的 Agent；新增的四个工作流都在，且职责互不重复', () => {
  const keys = new Set(BUILTIN_AGENTS.map((b) => b.key))
  for (const w of BUILTIN_WORKFLOWS)
    for (const k of builtinAgentKeys(w)) assert.ok(keys.has(k), `${w.name} 引用了不存在的 Agent「${k}」`)
  const names = BUILTIN_WORKFLOWS.map((w) => w.name)
  assert.equal(new Set(names).size, names.length, '工作流重名')
  for (const k of ['bootstrap', 'deps', 'migration', 'release'])
    assert.ok(
      BUILTIN_WORKFLOWS.some((w) => w.key === k),
      `缺少工作流 ${k}`,
    )
  // 依赖与安全有自己的 Agent，不是评价流程顺手做的
  assert.ok(BUILTIN_AGENTS.some((b) => b.key === 'deps'))
})

test('旧副本引用了已合并的 Agent：重定向到合并目标，说明和参数保留，重复跑不再改', async () => {
  const merged = {
    ...AgentInput.parse({ name: '文档维护', origin: 'builtin:docs' }),
    id: 'local-docs',
    createdAt: '',
    updatedAt: '',
  }
  const docsync = {
    ...AgentInput.parse({ name: '文档同步', origin: 'builtin:docsync' }),
    id: 'local-docsync',
    createdAt: '',
    updatedAt: '',
  }
  // 造一个旧副本：docs 节点指向已合并的「文档维护」，用户改过说明所以不会被整体升级
  const legacy = WorkflowInput.parse({
    name: '我改过的架构设计',
    categoryId: 'cat',
    mainAgentId: 'local-docsync',
    origin: 'builtin:architecture',
    entryFlowId: 'main',
    document: '我改过的说明',
    flows: [
      {
        id: 'main',
        name: '主流程',
        startPos: { x: 0, y: 0 },
        endPos: { x: 600, y: 0 },
        nodes: [
          {
            id: 'docs',
            title: '写文档',
            kind: 'agent',
            agentId: 'local-docs',
            flow: null,
            tier: 'medium',
            params: { bug: true },
            steps: [],
            retries: 0,
            instructions: '写架构文档',
            x: 0,
            y: 0,
            hooks: { start: null, review: null, end: null, maxRounds: 3 },
          },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'docs' },
          { id: 'e2', from: 'docs', to: 'end' },
        ],
      },
    ],
  })
  const saved: Workflow[] = []
  const ops = {
    async updateWorkflow(_id: string, input: WorkflowInput) {
      const next = Workflow.parse({ ...input, id: 'w1', createdAt: '', updatedAt: '' })
      saved.push(next)
      return next
    },
  }
  const state = {
    agents: [merged, docsync],
    categories: [],
    tags: [],
    workflows: [Workflow.parse({ ...legacy, id: 'w1', createdAt: '', updatedAt: '' })],
  }
  const [next] = await redirectMergedWorkflows(state, ops as never)
  const node = next.flows[0].nodes[0]
  assert.equal(node.agentId, 'local-docsync', '指向已合并 Agent 的节点改到合并目标')
  // 节点说明和参数原样保留
  assert.equal(node.instructions, '写架构文档')
  assert.deepEqual(node.params, { bug: true })
  // 重定向过以后再跑一遍：没有命中，不再写
  saved.length = 0
  assert.deepEqual(await redirectMergedWorkflows({ ...state, workflows: [next] }, ops as never), [])
  assert.equal(saved.length, 0)
})

test('AI 配参数的提示词带上每个开关管什么和节点预设，让 CLI 自己判断', () => {
  const coder = agent(
    'coder',
    [
      { key: 'tdd', label: 'TDD', type: 'bool', default: true },
      { key: 'scene', label: '先识别现场', type: 'bool', default: false },
    ],
    {
      instructions:
        '{{#if tdd}}新增行为先写失败的测试。{{else}}不强制 TDD。{{/if}}\n{{#if scene}}先只读识别现场。{{/if}}',
    },
  )
  const w = Workflow.parse({
    ...workflow({ mainAgentId: 'coder' }),
    flows: [
      { id: 'main', nodes: [{ id: 'n1', title: '理解需求', agentId: 'coder', params: { scene: true } }], edges: [] },
    ],
  })
  const prompt = buildAssistPrompt(
    'params',
    { agents: [coder], categories: [], workflows: [w], rules: '', target: w, paramSpec: derivedParams(w, [coder]) },
    [{ role: 'user', text: '按项目情况填' }],
    [],
  )
  assert.match(prompt, /打开时角色设定里会多出：新增行为先写失败的测试。/)
  assert.match(prompt, /关闭时角色设定里会多出：不强制 TDD。/)
  assert.match(prompt, /工作流节点上已预设：「理解需求」= true/)
  assert.match(prompt, /不要把参数的取舍拿去问用户/)
})
