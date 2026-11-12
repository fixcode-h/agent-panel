import assert from 'node:assert/strict'
import test from 'node:test'
import { runEngineTurn } from './engine.ts'
import type { AgentCall, AgentResult, EngineHost } from './engine-host.ts'
import { AgentInput, type Agent, type StopReason, type Task } from './schema.ts'
import { newTask } from './task.ts'

/**
 * 引擎一轮对话的直接单测（A9）：以前这几条路径只靠 e2e 和 server 侧的集成用例间接兜着，
 * 拆文件、改收尾时回归要到 e2e 才看得出。这里用假的宿主直接跑 runEngineTurn，只看引擎写进任务的状态：
 * 一轮的开始和结束、CLI 已报完成后被收掉的收口、派出子任务后停下等结果再接着跑。
 */
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
  ...extra,
})

/** 一个顶层的项目对话；converse 处理对话这一轮的调用，子任务的调用交给 helper */
function makeHost(
  converse: (call: AgentCall, task: Task) => Promise<AgentResult>,
  opts: { helper?: (call: AgentCall) => Promise<AgentResult>; stopReason?: StopReason } = {},
) {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'w', prompt: '改登录页' } as never, undefined, '', 't'),
    id: 't',
  } as Task
  const calls: AgentCall[] = []
  let n = 0
  const host: EngineHost = {
    task,
    agents: [agent('w', '执行', { canDelegate: true })],
    workflows: [],
    prompt: '改登录页',
    changed: () => {},
    newId: () => `id${++n}`,
    ...(opts.stopReason ? { stopReason: () => opts.stopReason } : {}),
    runAgent: async (call) => {
      // 子任务的调用带着它的节点（step）；对话自己的没有
      if (call.step) return opts.helper ? opts.helper(call) : { ok: true, text: '子任务结果' }
      calls.push(call)
      task.sessions[call.sessionKey] = 'sess-1'
      return converse(call, task)
    },
  }
  return { task, host, calls }
}

test('一轮的开始和结束：跑的时候记一轮进行中，答完记成完成；CLI 报错时这一轮记失败，错误写给用户', async () => {
  const seen: string[] = []
  const { task, host, calls } = makeHost(async (_call, t) => {
    // 交给 CLI 的那一刻：任务在跑，这一轮已经记下、还没结束
    seen.push(t.status, t.turns.at(-1)!.status, t.turns.at(-1)!.endedAt)
    return { ok: true, text: '改好了' }
  })
  await runEngineTurn(host)
  assert.deepEqual(seen, ['running', 'running', ''])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionKey, 'w')
  assert.match(calls[0].prompt, /改登录页/)
  assert.equal(task.status, 'done')
  assert.equal(task.turns.length, 1)
  assert.equal(task.turns[0].status, 'done')
  assert.ok(task.turns[0].endedAt)
  assert.equal(task.turns[0].title, '改登录页')

  // 下一轮报错：不悄悄重试，这一轮记失败、任务失败，原因作为系统消息给用户看
  const fail = makeHost(async () => ({ ok: false, error: 'CLI 退出码 1' }))
  await runEngineTurn(fail.host)
  assert.equal(fail.calls.length, 1)
  assert.equal(fail.task.status, 'failed')
  assert.equal(fail.task.turns.at(-1)!.status, 'failed')
  assert.ok(fail.task.messages.some((m) => m.role === 'system' && m.text.includes('CLI 退出码 1')))
})

test('end_turn 的收口：CLI 报过完成后才被收掉记成完成，没报完成就被收掉记成中断并说明原因', async () => {
  // CLI 用 end_turn 交代完、报了这一轮完成（turnDoneAt），停在等下一句时被闲置回收：不算被打断
  const done = makeHost(
    async (_call, t) => {
      t.turnDoneAt = new Date(Date.now() + 1).toISOString()
      return { ok: false, stopped: true, error: '' }
    },
    { stopReason: 'idle' },
  )
  await runEngineTurn(done.host)
  assert.equal(done.task.status, 'done')
  assert.equal(done.task.turns.at(-1)!.status, 'done')
  assert.equal(done.task.stopReason, undefined)
  assert.ok(!done.task.messages.some((m) => m.text.includes('这一轮被中断')))

  // 面板在对话彻底完成后收掉的（finish）：CLI 来没来得及报完成都算答完
  const finish = makeHost(async () => ({ ok: false, stopped: true, error: '' }), { stopReason: 'finish' })
  await runEngineTurn(finish.host)
  assert.equal(finish.task.status, 'done')
  assert.equal(finish.task.turns.at(-1)!.status, 'done')

  // 没报完成就被面板重启收掉：记成停止，写明是谁结束的，「继续执行」能接着做
  const cut = makeHost(async () => ({ ok: false, stopped: true, error: '' }), { stopReason: 'restart' })
  await runEngineTurn(cut.host)
  assert.equal(cut.task.status, 'stopped')
  assert.equal(cut.task.turns.at(-1)!.status, 'stopped')
  assert.equal(cut.task.stopReason, 'restart')
  assert.ok(cut.task.messages.some((m) => m.role === 'system' && m.text.includes('这一轮被中断')))
})

test('派出子任务后：这一轮停下等结果，子任务交回后结果接着交给同一个会话，交完才算这一轮结束', async () => {
  let release!: (r: AgentResult) => void
  const helperDone = new Promise<AgentResult>((r) => (release = r))
  const states: string[] = []
  const { task, host, calls } = makeHost(
    async (call) => {
      if (calls.length === 1) {
        const r = call.orch!.spawn([{ title: '查代码', instructions: '查一下登录页', agent: '执行' }])
        assert.equal(r.ids.length, 1, r.error ?? '')
        return { ok: true, text: '已经派人去查了' }
      }
      return { ok: true, text: '根据结果改好了' }
    },
    {
      helper: async () => {
        states.push('helper')
        return helperDone
      },
    },
  )
  const run = runEngineTurn(host)
  // 等引擎把子任务派出去、停在等结果上
  for (let i = 0; i < 50 && !states.length; i++) await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(calls.length, 1, '子任务没交回前不再调对话')
  assert.equal(task.status, 'running')
  assert.equal(task.turns.at(-1)!.status, 'running', '等子任务时这一轮还没结束')
  assert.equal(task.steps.filter((s) => s.slot === 'sub' && s.status === 'running').length, 1)

  release({ ok: true, text: '登录页在 web/login.tsx' })
  await run
  assert.equal(calls.length, 2)
  // 第二圈是子任务交回的结果，接在同一个会话上，不是重新发规则
  assert.equal(calls[1].carry, true)
  assert.equal(calls[1].sessionKey, 'w')
  assert.match(calls[1].prompt, /web\/login\.tsx/)
  assert.ok(task.messages.some((m) => m.panel === 'helpers'))
  assert.equal(task.turns.length, 1, '等结果、交回结果都算同一轮')
  assert.equal(task.turns[0].status, 'done')
  assert.equal(task.status, 'done')
})
