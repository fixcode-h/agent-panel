/**
 * 父对话测试队列（ADR 0018 / ADR 0020）：合并后按顺序在父对话目录里跑范围是「全量，合并后由父对话跑」的步骤，
 * 一次只跑一批的一步（多个子对话同时合并时不并发跑重测试），
 * 成功交给子对话收尾，失败把失败的步骤和输出交回去修。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createParentTests, parentTestJobName, parentTestRun, type ParentTestFail } from './parent-tests.ts'
import { createBackground } from './background.ts'
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
  /** 完整的失败对象：断言 stopped 这类标记用（failed 只留对比用的几个字段） */
  const failedDetail: ParentTestFail[] = []
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
      failedDetail.push(failedStep)
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
  return { tests, started, passed, failed, failedDetail, recorded, startedMax }
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

/** 等条件成立：后台命令和队列的推进都在真实的事件循环里跑，假时钟推不动 */
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`等了 ${ms}ms 仍未成立：${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('父对话测试命令被停止：把结论交回子对话，不会永远停在「等父对话测试」', async () => {
  const ends: ((r: unknown) => void)[] = []
  const fake = ((_line: string, _cwd: string, o: { onLine: (l: string) => void; signal?: AbortSignal }) =>
    new Promise((resolve) => {
      ends.push(resolve)
      o.signal?.addEventListener('abort', () => resolve({ code: null, killed: 'stopped', stderr: '' }))
    })) as unknown as NonNullable<Parameters<typeof createBackground>[1]>['run']
  const dir = mkdtempSync(path.join(tmpdir(), 'parent-test-stop-'))
  const failed: ParentTestFail[] = []
  const passed: string[] = []
  let bg: ReturnType<typeof createBackground>
  const tests = createParentTests({
    // 照 server/tasks/test-runs.ts 的接线：父对话测试命令带 notifyOnStop，被停掉时结果也要回来
    start: async ({ step: s, name }) => {
      const r = bg.start({
        taskId: 'p',
        name,
        command: s.command,
        cwd: s.cwd,
        root: dir,
        exclusive: true,
        notifyOnStop: true,
      })
      return r.ok ? { ok: true, id: r.id! } : { ok: false, info: r.info }
    },
    pass: async (run) => {
      passed.push(run.childId)
    },
    fail: async (_run, f) => {
      failed.push(f)
    },
    record: async () => {},
  })
  // 照 server/tasks/jobs.ts 的接线：结果只看后台命令是不是真的跑完了，被停止按未通过处理
  bg = createBackground(
    (job) => {
      void tests.finishJob(job.id, {
        ok: job.state === 'done',
        durationMs: 10,
        output: '',
        stopped: job.state === 'stopped',
      })
    },
    { run: fake },
  )
  tests.enqueue({
    parentId: 'p',
    childId: 'c1',
    childTitle: 'A',
    steps: [step('tc', '单元测试'), step('e2e', '端到端测试')],
  })
  await until(() => ends.length === 1, '第一条父对话测试命令跑起来')
  const jobId = bg.list('p').find((j) => j.state === 'running')!.id
  assert.equal(bg.stopOne('p', jobId).ok, true)
  await until(() => failed.length === 1, '被停止后要把结论交回子对话')
  assert.equal(failed[0].index, 0, '停在第 1 步')
  assert.equal(failed[0].stopped, true, '失败说明里要写清是被停止的，不是自己跑完的')
  assert.equal(passed.length, 0, '被停止不能算通过')
  assert.equal(tests.statusOf('c1'), '', '队列不再占着它：子对话可以重新收尾')
  assert.equal(bg.list('p').filter((j) => j.state === 'running').length, 0, '后面的步骤没有跟着跑')
  void bg.stop('p')
})

test('父对话被停止 / 归档：正在跑的那批按未通过退回子对话，不留到重启', async () => {
  const h = harness()
  h.tests.enqueue({
    parentId: 'p',
    childId: 'c1',
    childTitle: 'A',
    steps: [step('a1', '一'), step('a2', '二')],
  })
  await h.tests.idle()
  assert.equal(h.tests.statusOf('c1'), 'running')
  assert.equal(await h.tests.abortByParent('p', '父对话被停止或归档'), true)
  assert.deepEqual(
    h.failed,
    [{ childId: 'c1', index: 0, stepId: 'a1', output: '父对话被停止或归档' }],
    '把正在跑的那步按未通过退回子对话',
  )
  assert.equal(h.failedDetail[0].stopped, true, '退出时要标成“被停止”，失败文案里要写清')
  assert.equal(h.passed.length, 0)
  assert.equal(h.tests.statusOf('c1'), '', '队列不再占着它')
  assert.deepEqual(
    h.started.map((s) => s.stepId),
    ['a1'],
    '不继续起下一步',
  )
  assert.equal(await h.tests.abortByParent('other', 'x'), false, '不是这个父对话的批次不动')
})

test('父对话被停止时队里排着的批次一起退回：不会把下一批起成新命令再被静默停掉', async () => {
  const h = harness()
  h.tests.enqueue({ parentId: 'p', childId: 'c1', childTitle: 'A', steps: [step('a1', '一')] })
  h.tests.enqueue({ parentId: 'p', childId: 'c2', childTitle: 'B', steps: [step('b1', '二')] })
  await h.tests.idle()
  assert.equal(h.tests.statusOf('c1'), 'running')
  assert.equal(h.tests.statusOf('c2'), 'queued')
  assert.equal(await h.tests.abortByParent('p', '父对话被停止'), true)
  assert.deepEqual(
    [...h.failed.map((f) => f.childId)].sort(),
    ['c1', 'c2'],
    '跑着的和队里排着的都退回，不会留下 testing',
  )
  assert.deepEqual(
    h.started.map((s) => s.childId),
    ['c1'],
    '没有把队里的下一批起成新命令',
  )
  assert.equal(h.tests.statusOf('c1'), '')
  assert.equal(h.tests.statusOf('c2'), '')
})
