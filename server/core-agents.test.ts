import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentInput, type Agent, type Category, type Tag } from '../shared/schema.ts'
import { BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
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
      { key: 'commit', label: 'x', type: 'select', options: [], default: '做完提交' },
      { key: 'extra', label: 'x', type: 'text', default: '多出来的' },
    ],
    origin: 'builtin:worker',
  })
  const next = syncCore(cur, def, { categoryId: 'c', includes: [] })
  assert.equal(next.params.find((p) => p.key === 'mode')?.default, '自动')
  assert.equal(next.params.find((p) => p.key === 'commit')?.default, '做完提交')
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
