/**
 * 父对话测试队列（ADR 0018 / ADR 0020）：合并后按顺序在父对话目录里跑范围是「全量，合并后由父对话跑」的步骤，
 * 一次只跑一批的一步（多个子对话同时合并时不并发跑重测试），
 * 成功交给子对话收尾，失败把失败的步骤和输出交回去修。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createParentTests, parentTestJobName, parentTestRun } from './parent-tests.ts'
import { type TestStep, ProjectInput } from '../shared/schema.ts'

const step = (id: string, name: string, command = 'run'): TestStep => ({
  id,
  name,
  command,
  env: 'auto',
  cwd: '',
  when: '',
  appliesTo: [],
  timeoutSec: 0,
  note: '',
  enabled: true,
  merge: false,
  scope: 'parent',
  quick: false,
})

/** 受控的「起一条后台命令」：记下调用顺序，返回可预测的编号 */
function harness() {
  let seq = 0
  const started: { jobId: string; name: string; stepId: string; childId: string }[] = []
  const startedMax = { running: 0 }
  const passed: string[] = []
  const failed: { childId: string; index: number; stepId: string; output: string }[] = []
  const recorded: { stepId: string; ok: boolean; durationMs: number }[] = []
  const tests = createParentTests({
    start: async ({ run, step, name }) => {
      const jobId = `j${++seq}`
      started.push({ jobId, name, stepId: step.id, childId: run.childId })
      return { ok: true, id: jobId }
    },
    pass: async (run) => {
      passed.push(run.childId)
    },
    fail: async (run, failedStep) => {
      failed.push({
        childId: run.childId,
        index: failedStep.index,
        stepId: failedStep.step.id,
        output: failedStep.output,
      })
    },
    record: async (_run, step, done) => {
      recorded.push({ stepId: step.id, ok: done.ok, durationMs: done.durationMs })
    },
    onError: (where, error) => {
      throw new Error(`${where}: ${error.message}`)
    },
  })
  return { tests, started, passed, failed, recorded, startedMax }
}

test('一批步骤按配置的顺序跑，全部通过才让子对话收尾', async () => {
  const h = harness()
  h.tests.enqueue({
    parentId: 'p',
    childId: 'c1',
    childTitle: '修登录',
    steps: [step('tc', '类型检查'), step('e2e', '端到端测试')],
  })
  await h.tests.idle()
  assert.deepEqual(
    h.started.map((s) => s.stepId),
    ['tc'],
    '一次只起一步',
  )
  assert.equal(h.started[0].name, '父对话测试：修登录 · 类型检查', '后台命令名里带子对话和步骤名')
  assert.equal(await h.tests.finishJob('j1', { ok: true, durationMs: 1200, output: '' }), true)
  assert.deepEqual(
    h.started.map((s) => s.stepId),
    ['tc', 'e2e'],
    '上一步通过后起下一步',
  )
  assert.deepEqual(h.passed, [], '还没跑完不收尾')
  assert.equal(await h.tests.finishJob('j2', { ok: true, durationMs: 94_000, output: '' }), true)
  assert.deepEqual(h.passed, ['c1'], '全部通过后让子对话收尾')
  assert.deepEqual(
    h.recorded,
    [
      { stepId: 'tc', ok: true, durationMs: 1200 },
      { stepId: 'e2e', ok: true, durationMs: 94_000 },
    ],
    '每一步都记耗时，一步一条',
  )
  assert.equal(h.tests.statusOf('c1'), '', '跑完了就不在队列里')
})

test('有一步失败：停在这一步、把输出交回子对话，后面的步骤不再跑', async () => {
  const h = harness()
  h.tests.enqueue({
    parentId: 'p',
    childId: 'c1',
    childTitle: '修登录',
    steps: [step('tc', '类型检查'), step('e2e', '端到端测试')],
  })
  await h.tests.idle()
  await h.tests.finishJob('j1', { ok: false, durationMs: 42_000, output: 'TypeError: boom' })
  assert.deepEqual(
    h.failed,
    [{ childId: 'c1', index: 0, stepId: 'tc', output: 'TypeError: boom' }],
    '失败要带上哪一步和输出原文',
  )
  assert.deepEqual(h.passed, [])
  assert.deepEqual(
    h.started.map((s) => s.stepId),
    ['tc'],
    '失败后不再起下一步',
  )
  assert.equal(h.recorded[0].ok, false, '失败那次也记耗时：收尾总结里要看得到它')
})

test('多个子对话同时合并：排成一条队，一次只跑一步，结果回到各自的子对话', async () => {
  const h = harness()
  h.tests.enqueue({
    parentId: 'p',
    childId: 'c1',
    childTitle: 'A',
    steps: [step('a1', 'A 的测试'), step('a2', 'A 的测试 2')],
  })
  h.tests.enqueue({ parentId: 'p', childId: 'c2', childTitle: 'B', steps: [step('b1', 'B 的测试')] })
  await h.tests.idle()
  assert.deepEqual(
    h.started.map((s) => s.childId),
    ['c1'],
    '同一时间只跑一批的一步',
  )
  assert.equal(h.tests.statusOf('c2'), 'queued')
  await h.tests.finishJob('j1', { ok: true, durationMs: 1000, output: '' })
  // A 还有第二步：先跑完 A，再跑 B（同一批不交错）
  assert.deepEqual(
    h.started.map((s) => s.stepId),
    ['a1', 'a2'],
  )
  await h.tests.finishJob('j2', { ok: false, durationMs: 500, output: 'A 挂了' })
  assert.deepEqual(
    h.failed.map((f) => f.childId),
    ['c1'],
    '失败回到 A 自己，不能串到 B',
  )
  await h.tests.idle()
  assert.deepEqual(
    h.started.map((s) => s.childId),
    ['c1', 'c1', 'c2'],
    'A 这一批结束后才轮到 B',
  )
})

test('同一个子对话重复排队不会跑两遍；不是这批的后台命令不处理', async () => {
  const h = harness()
  const a = h.tests.enqueue({ parentId: 'p', childId: 'c1', childTitle: 'A', steps: [step('a1', '测试')] })
  const b = h.tests.enqueue({ parentId: 'p', childId: 'c1', childTitle: 'A', steps: [step('a1', '测试')] })
  assert.equal(a, b, '已经排着时返回原来那批')
  await h.tests.idle()
  assert.equal(h.started.length, 1)
  assert.equal(await h.tests.finishJob('other', { ok: true, durationMs: 1, output: '' }), false)
  assert.equal(h.started.length, 1, '别的后台命令不会推进这批')
})

test('命令起不来也按失败交回子对话，后面的批次照常跑', async () => {
  let n = 0
  const failed: string[] = []
  const passed: string[] = []
  const tests = createParentTests({
    start: async () => (++n === 1 ? { ok: false, info: '工作目录不对' } : { ok: true, id: 'x' }),
    pass: async (run) => {
      passed.push(run.childId)
    },
    fail: async (run, f) => {
      failed.push(`${run.childId}|${f.output}`)
    },
    record: async () => {},
  })
  tests.enqueue({ parentId: 'p', childId: 'c1', childTitle: 'A', steps: [step('a1', '测试')] })
  tests.enqueue({ parentId: 'p', childId: 'c2', childTitle: 'B', steps: [step('b1', '测试')] })
  await tests.idle()
  assert.deepEqual(failed, ['c1|工作目录不对'], '起不来要把原因交回子对话')
  // 后面的批次照常跑：只是它也还在等自己的后台命令
  assert.equal(tests.statusOf('c2'), 'running')
  await tests.finishJob('x', { ok: true, durationMs: 10, output: '' })
  assert.deepEqual(passed, ['c2'], '后面的批次不受影响')
})

test('耗时记录的字段名和 schema 对齐：执行方是父对话', () => {
  const parse = ProjectInput.parse({ name: '项目', path: '/tmp/p' })
  assert.deepEqual(parse.testSteps, [])
  assert.deepEqual(parentTestRun(step('e2e', '端到端测试'), { ok: true, durationMs: 93_600.4 }, '2026-10-26'), {
    stepId: 'e2e',
    stepName: '端到端测试',
    by: 'parent',
    ok: true,
    durationMs: 93_600,
    at: '2026-10-26',
  })
  assert.match(parentTestJobName('A', '端到端测试'), /父对话测试：A · 端到端测试/)
})

test('独立分支被丢弃时取消批次：跑着的停掉、结果吞掉，下一批照常开始', async () => {
  const h = harness()
  h.tests.enqueue({
    parentId: 'p',
    childId: 'c1',
    childTitle: 'A',
    steps: [step('a1', 'A 的测试'), step('a2', 'A 的测试 2')],
  })
  h.tests.enqueue({ parentId: 'p', childId: 'c2', childTitle: 'B', steps: [step('b1', 'B 的测试')] })
  await h.tests.idle()
  const jobId = h.started[0].jobId
  assert.equal(h.tests.cancel('c1'), jobId, '返回正在跑的那条命令，交给调用方去停')
  // 停掉的那条结果回来：吞掉，不记耗时、不 fail、不 pass（评审 R4）
  assert.equal(await h.tests.finishJob(jobId, { ok: false, durationMs: 10, output: '被停掉' }), true)
  await h.tests.idle()
  assert.deepEqual(h.failed, [], '丢弃分支后不再把失败交回子对话')
  assert.deepEqual(h.passed, [])
  assert.deepEqual(h.recorded, [])
  assert.deepEqual(
    h.started.map((s) => s.childId),
    ['c1', 'c2'],
    '下一批照常开始，不跟着一起卡住',
  )
  assert.equal(h.tests.statusOf('c1'), '')
  // 还排在队列里的也能取消：不会启动
  h.tests.cancel('c2')
  assert.equal(h.tests.statusOf('c2'), '')
})

test('取消落在起命令的窗口里：刚起来的那条交给调用方停掉，不再启动下一步', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const started: string[] = []
  const stopped: string[] = []
  let n = 0
  const tests = createParentTests({
    start: async () => {
      const id = `j${++n}`
      started.push(id)
      if (n === 1) await gate
      return { ok: true, id }
    },
    pass: async () => {
      throw new Error('取消后不该通过')
    },
    fail: async () => {
      throw new Error('取消后不该失败')
    },
    record: async () => {},
    stop: (_run, jobId) => {
      stopped.push(jobId)
    },
  })
  tests.enqueue({ parentId: 'p', childId: 'c1', childTitle: 'A', steps: [step('a1', '一'), step('a2', '二')] })
  // 等 start 进到 await 里（此时命令还没有编号）
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(started, ['j1'])
  assert.equal(tests.cancel('c1'), undefined, '还没拿到编号，没有可停的')
  release()
  await tests.idle()
  assert.deepEqual(started, ['j1'], '取消后不再启动下一步')
  assert.deepEqual(stopped, ['j1'], '刚起来的命令交给调用方停掉（评审 R1）')
  assert.equal(tests.statusOf('c1'), '')
})

test('结果回来、落耗时期间取消：不推进下一步，也不回传', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const started: string[] = []
  const passed: number[] = []
  const failed: number[] = []
  let n = 0
  const tests = createParentTests({
    start: async () => {
      const id = `j${++n}`
      started.push(id)
      return { ok: true, id }
    },
    pass: async () => {
      passed.push(1)
    },
    fail: async () => {
      failed.push(1)
    },
    record: async () => {
      await gate
    },
  })
  tests.enqueue({ parentId: 'p', childId: 'c1', childTitle: 'A', steps: [step('a1', '一'), step('a2', '二')] })
  await tests.idle()
  assert.deepEqual(started, ['j1'])
  const done = tests.finishJob('j1', { ok: true, durationMs: 10, output: '' })
  await new Promise((r) => setImmediate(r))
  // 现在挂在 record 里；这条命令已经结束（jobId 已摘掉），取消只停后续
  assert.equal(tests.cancel('c1'), undefined)
  release()
  await done
  await tests.idle()
  assert.deepEqual(started, ['j1'], '取消后不再启动下一步')
  assert.deepEqual(passed, [], '取消后不把结果交给 pass')
  assert.deepEqual(failed, [])
})
