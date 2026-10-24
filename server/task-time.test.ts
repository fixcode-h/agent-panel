import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginTurn,
  endRun,
  idleWaitDuration,
  pauseRun,
  pauseStep,
  resumeRun,
  stepMs,
  taskDuration,
  trackWait,
  turnStats,
  waitDuration,
} from '../shared/task.ts'

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
const ms = (s: number) => Date.parse(at(s))

test('等用户的时间从请求发出时算起，处理完累加到任务和所在节点', () => {
  const step = { id: 'n1', waitMs: 0, waitStartedAt: '' }
  const task = {
    waitMs: 0,
    waitStartedAt: '',
    steps: [step, { id: 'n2', waitMs: 0, waitStartedAt: '' }],
    requests: [{ step: 'n1', at: at(10) }],
  }
  // 发请求后过了一会儿才调用，开始时间仍是请求发出的时间
  trackWait(task, ms(12))
  assert.equal(task.waitStartedAt, at(10))
  assert.equal(waitDuration(task, ms(20)), 10_000)
  task.requests = []
  trackWait(task, ms(25))
  assert.equal(task.waitMs, 15_000)
  assert.equal(step.waitMs, 15_000)
  assert.equal(task.steps[1].waitMs, 0)
  assert.equal(task.waitStartedAt, '')
})

test('停下时挂着的等待随这一轮结束', () => {
  const task = {
    runMs: 0,
    runStartedAt: at(5),
    waitMs: 0,
    waitStartedAt: at(5),
    idleWaitMs: 0,
    idleWaitAt: '',
    steps: [],
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 },
    turns: [],
  }
  const turn = beginTurn(task, 't1', '再加一个按钮\n细节……', 'a1', ms(5))
  assert.equal(turn.title, '再加一个按钮')
  task.usage = { inputTokens: 400, outputTokens: 30, cacheReadTokens: 290 }
  // 执行中的一轮按现在的累计减去开始时的
  assert.deepEqual(turnStats(task, turn, ms(7)), {
    inputTokens: 300,
    outputTokens: 20,
    cacheReadTokens: 240,
    waitMs: 2000,
  })
  endRun(task, new Date(ms(9)))
  assert.equal(task.runMs, 4000)
  assert.equal(task.waitMs, 4000)
  // 停下时还在执行的一轮记为暂停，用量定下来
  assert.equal(turn.status, 'stopped')
  assert.equal(turn.inputTokens, 300)
  assert.equal(turn.waitMs, 4000)
})

test('答完等下一句的时间不算执行，单独累加，不混进「等你确认/提问」', () => {
  // 第 0 秒开始执行，第 5 秒答完、停在等下一句
  const task = {
    runMs: 0,
    runStartedAt: at(0),
    waitMs: 0,
    waitStartedAt: '',
    idleWaitMs: 0,
    idleWaitAt: '',
    status: 'running',
    createdAt: at(0),
    updatedAt: at(0),
  }
  pauseRun(task, ms(5))
  assert.equal(task.runMs, 5000, '停下来之前的才算执行')
  assert.equal(task.runStartedAt, '', '停下时不再累计')
  assert.equal(task.idleWaitAt, at(5), '从这一刻开始等下一句')
  assert.equal(task.waitStartedAt, '', '等下一句不算「等你确认/提问」')

  // 用户第 100 秒才回复
  assert.equal(taskDuration(task, ms(100)), 5000, '停着的 95 秒不算执行')
  assert.equal(idleWaitDuration(task, ms(100)), 95_000, '这段是等下一句')
  assert.equal(waitDuration(task, ms(100)), 0, '不混进等你确认的时间')
  resumeRun(task, ms(100))
  assert.equal(task.idleWaitMs, 95_000, '等下一句结算进 idleWaitMs')
  assert.equal(task.waitMs, 0)
  assert.equal(task.runStartedAt, at(100), '从回复的那一刻继续算执行')
  assert.equal(taskDuration(task, ms(110)), 15_000)
})

test('停下时停在等待工具上：等确认收进 waitMs，等下一句收进 idleWaitMs，都不算执行', () => {
  const task = {
    runMs: 0,
    runStartedAt: at(0),
    waitMs: 0,
    waitStartedAt: '',
    idleWaitMs: 0,
    idleWaitAt: '',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    turns: [],
  }
  // 第 10 秒弹出提问（等确认，同时还在跑），第 20 秒答完、停在等下一句
  task.waitStartedAt = at(10)
  pauseRun(task, ms(20))
  endRun(task, new Date(ms(120)))
  assert.equal(task.runMs, 20_000, '执行只有前 20 秒')
  assert.equal(task.waitMs, 110_000, '等你回答的 110 秒（含执行里的那一段）')
  assert.equal(task.idleWaitMs, 100_000, '答完后等下一句的 100 秒单独记')
})

test('节点被打断后续接，耗时接着累加', () => {
  const step = { startedAt: at(0), endedAt: '', status: 'running', spentMs: 0 }
  assert.equal(stepMs(step, ms(3)), 3000)
  pauseStep(step, ms(4))
  step.endedAt = at(4)
  step.status = 'pending'
  assert.equal(stepMs(step), 4000)
  Object.assign(step, { startedAt: at(100), endedAt: at(106), status: 'done' })
  assert.equal(stepMs(step), 10_000)
})
