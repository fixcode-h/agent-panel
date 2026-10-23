import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentInput, type Agent, type Category, type Tag } from '../shared/schema.ts'
import { BUG_METHOD, BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
import { renderTemplate } from '../shared/agent-role.ts'
import { ensureProjectAgents } from '../shared/builtin/install.ts'
import {
  CORE_AGENTS,
  coreDefinition,
  findCore,
  isCoreAgent,
  syncCore,
  withProjectParams,
} from '../shared/builtin/core.ts'

/** 内存里的集合，模拟服务端的 agents / categories / tags */
function memory() {
  const agents: Agent[] = []
  const categories: Category[] = []
  const tags: Tag[] = []
  let n = 0
  const id = () => `id${++n}`
  const at = new Date(0).toISOString()
  return {
    agents,
    state: () => ({ agents: [...agents], categories: [...categories], tags: [...tags], workflows: [] as never[] }),
    ops: {
      async createAgent(input: AgentInput) {
        const a = { ...AgentInput.parse(input), id: id(), createdAt: at, updatedAt: at }
        agents.push(a)
        return a
      },
      async createCategory(name: string, scope: 'agent' | 'workflow') {
        const c = { id: id(), name, scope, createdAt: at, updatedAt: at }
        categories.push(c)
        return c
      },
      async createTag(input: { name: string }) {
        const x = {
          id: id(),
          name: input.name,
          color: 'violet' as const,
          description: '',
          createdAt: at,
          updatedAt: at,
        }
        tags.push(x)
        return x
      },
      async createWorkflow(): Promise<never> {
        throw new Error('不该建工作流')
      },
      async updateAgent(aid: string, input: AgentInput) {
        const i = agents.findIndex((a) => a.id === aid)
        agents[i] = { ...agents[i], ...AgentInput.parse(input) }
        return agents[i]
      },
    },
  }
}

test('必备角色：启动时四个都装好，重复启动不再改', async () => {
  const m = memory()
  const r = await ensureProjectAgents(m.state(), m.ops)
  for (const c of CORE_AGENTS) assert.ok(findCore(m.agents, c.key), `缺 ${c.key}`)
  assert.ok(r.created.length >= 4)
  const again = await ensureProjectAgents(m.state(), m.ops)
  assert.equal(again.created.length, 0)
  assert.equal(again.synced.length, 0, '没有变化时不写盘')
})

test('通用约束：连续工具操作时要报告可见进度', () => {
  const rules = BUILTIN_AGENTS.find((a) => a.key === 'rules')!.agent.instructions
  assert.match(rules, /连续做两次以上工具操作前先用一句话说明当前目标/)
  assert.match(rules, /模型没有返回思考内容时不要编造内部思考/)
})

test('通用约束：等待要有死的数字上限，超时判阻塞，不靠轮询耗时间', () => {
  const rules = BUILTIN_AGENTS.find((a) => a.key === 'rules')!.agent.instructions
  // 只写「不要轮询」拦不住：实际发生过连发 sleep 90/100/120/150/180 共 640 秒
  assert.match(rules, /单次不超过 30 秒/)
  assert.match(rules, /同一件事累计不超过 2 分钟/)
  assert.match(rules, /超过 2 分钟没有新进展就判定阻塞/)
  assert.match(rules, /不要自己写 `sleep` 循环轮询/)
  // 自己验证过的结论不要再等子任务重复验证（那次空等 307 秒就属于这类）
  assert.match(rules, /已经自己验证过结论时，不要再等子任务重复验证/)
})

test('通用约束：已授权的操作照做；统筹不再另立一份授权规则', () => {
  const rules = BUILTIN_AGENTS.find((a) => a.key === 'rules')!.agent.instructions
  assert.match(rules, /用户已经明确授权的操作照授权的做/)
  assert.match(rules, /不要自行换成更保守的做法（改走 PR、只提交不推送）/)
  const orch = BUILTIN_AGENTS.find((a) => a.key === 'orchestrator')!.agent.instructions
  assert.doesNotMatch(orch, /推送、PR、submit 要用户明确授权/, '授权规则只在通用约束里写一份')
})

test('Bug：统筹只定位到模块，执行和开发从模块逐层定位，找到就停', () => {
  const role = (key: string) => BUILTIN_AGENTS.find((a) => a.key === key)!.agent.instructions
  // 只写「找到根因」时 Agent 会一路挖到底层：起点、往下一层的条件、停止和深度上限都要写成能照做的规则
  assert.match(BUG_METHOD, /用户点名的模块或部分 → 父对话交来的模块/)
  assert.match(BUG_METHOD, /这一层排除了才往下一层/)
  assert.match(BUG_METHOD, /不要再往更底层找「更根本」的问题/)
  assert.match(BUG_METHOD, /不改代码去猜，先加临时日志或写针对性的测试复现/)
  assert.match(BUG_METHOD, /下到第三层还没找到/)

  const orch = role('orchestrator')
  assert.match(orch, /## Bug 怎么交/)
  assert.match(orch, /不去读实现找具体是哪一行/)
  assert.match(orch, /不要为同一个 Bug 开几个子对话同时找/)

  const worker = role('worker')
  assert.ok(renderTemplate(worker, { mode: '自动' }).includes(BUG_METHOD))
  assert.match(renderTemplate(worker, { mode: '自动' }), /Bug：不启动工作流/)
  assert.match(renderTemplate(worker, { mode: '总是按工作流' }), /按可用工作流里的「Bug 修复」执行/)

  const dev = role('developer')
  assert.ok(renderTemplate(dev, { task: '修 Bug' }).includes(BUG_METHOD))
  assert.ok(!renderTemplate(dev, { task: '实现' }).includes(BUG_METHOD))
  assert.ok(!renderTemplate(dev, { task: '性能问题' }).includes(BUG_METHOD), '性能问题按基线走，不套 Bug 的逐层定位')
})

test('必备角色：改了设定会被同步回内置定义，参数取值和运行配置保留', async () => {
  const m = memory()
  await ensureProjectAgents(m.state(), m.ops)
  const docs = findCore(m.agents, 'docsync')!
  const i = m.agents.indexOf(docs)
  m.agents[i] = {
    ...docs,
    name: '随便改的名字',
    instructions: '被改成了别的角色',
    canDelegate: true,
    enabled: false,
    model: '@high',
    params: docs.params.map((p) => (p.key === 'docRoot' ? { ...p, default: 'doc/' } : p)),
  }
  const r = await ensureProjectAgents(m.state(), m.ops)
  assert.equal(r.synced.length, 1)
  const now = findCore(m.agents, 'docsync')!
  const def = coreDefinition('docsync').agent
  assert.equal(now.name, def.name)
  assert.equal(now.instructions, def.instructions)
  assert.equal(now.canDelegate, false)
  assert.equal(now.enabled, true, '必备角色不能停用')
  assert.equal(now.model, '@high', '模型是运行配置，保留')
  assert.equal(now.params.find((p) => p.key === 'docRoot')?.default, 'doc/', '参数取值保留')
})

test('必备角色：不合法的参数值退回内置默认，定义里没有的参数去掉', () => {
  const def = coreDefinition('worker')
  const cur = AgentInput.parse({
    ...def.agent,
    params: [
      { key: 'mode', label: 'x', type: 'select', options: ['乱写'], default: '乱写' },
      { key: 'batch', label: 'x', type: 'select', options: [], default: '中' },
      { key: 'extra', label: 'x', type: 'text', default: '多出来的' },
    ],
    origin: 'builtin:worker',
  })
  const next = syncCore(cur, def, { categoryId: 'c', includes: [] })
  assert.equal(next.params.find((p) => p.key === 'mode')?.default, '自动')
  assert.equal(next.params.find((p) => p.key === 'batch')?.default, '中')
  assert.ok(!next.params.some((p) => p.key === 'extra'))
  assert.ok(isCoreAgent(next))
})

test('项目里给必备角色填的参数当作这个项目里的默认值，别的角色不受影响', async () => {
  const m = memory()
  await ensureProjectAgents(m.state(), m.ops)
  const tester = findCore(m.agents, 'tester')!
  const other = m.agents.find((a) => !isCoreAgent(a) && a.params.length)!
  const out = withProjectParams(m.agents, {
    agentParams: { [tester.id]: { scope: '整体', bogus: 1 }, [other.id]: { [other.params[0].key]: 'x' } },
  })
  assert.equal(out.find((a) => a.id === tester.id)!.params.find((p) => p.key === 'scope')?.default, '整体')
  assert.deepEqual(
    out.find((a) => a.id === other.id),
    other,
  )
})
