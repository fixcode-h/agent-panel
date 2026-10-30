import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBackground, uiJobs, type BgJob, type BgTimers } from './background.ts'
import { childHoldsOf } from '../shared/task.ts'

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return dir
}

/** 把一段 node 脚本写进目录，命令直接跑脚本：cmd 和 sh 对引号、分号的处理不一样，不把代码拼进命令行 */
function nodeScript(dir: string, name: string, code: string) {
  writeFileSync(path.join(dir, name), code)
  return `node ${name}`
}

/** 把控制权交回事件循环，让排队的微任务（promise 的 then）跑完 */
const tick = () => new Promise<void>((r) => setImmediate(r))

/**
 * 可控的假时钟：只有 advance() 推进时间才触发定时器。
 * 后台命令的超时兜底不能靠真实计时——等真实定时器时事件循环先空掉，node:test 会把用例判成 cancelledByParent
 */
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    impl: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq
        timers.set(id, { at: now + Math.max(0, ms), run: fn })
        return id
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as number)
      },
    } satisfies BgTimers,
    /** 推进时间：到点的定时器按先后顺序执行，每执行一个就让微任务跑完 */
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
        await tick()
      }
      now = target
    },
    /** 还排着的定时器：用例结束前应该清空 */
    pending: () => [...timers.keys()],
  }
}

/** 收集跑完的结果，等到够数为止 */
function collect(n: number, deps: Parameters<typeof createBackground>[1] = {}) {
  const got: { job: BgJob; text: string }[] = []
  let done: () => void = () => {}
  const all = new Promise<void>((r) => (done = r))
  const bg = createBackground((job, text) => {
    got.push({ job, text })
    if (got.length === n) done()
  }, deps)
  return { bg, got, all }
}

test('后台命令马上返回，跑完把结果推回；跑的期间文件变了要提醒', async () => {
  const dir = repo()
  const { bg, got, all } = collect(2)
  const a = bg.start({ taskId: 't1', name: '回显', command: 'echo hello', cwd: '', root: dir, exclusive: false })
  assert.ok(a.ok)
  assert.match(a.info, /已放到后台/)
  // 用脚本写文件并以 3 退出：cmd 不把 ; 当分隔符，Windows 下这个用例会变成成功
  const fail = nodeScript(dir, 'fail.cjs', "require('fs').writeFileSync('a.txt', 'two')\nprocess.exit(3)\n")
  bg.start({ taskId: 't1', name: '改文件', command: fail, cwd: '', root: dir, exclusive: false })
  await all
  const ok = got.find((g) => g.job.name === '回显')!
  assert.equal(ok.job.state, 'done')
  assert.match(ok.text, /成功/)
  assert.match(ok.text, /hello/)
  const bad = got.find((g) => g.job.name === '改文件')!
  assert.equal(bad.job.state, 'failed')
  assert.equal(bad.job.code, 3)
  assert.ok(bad.job.changed)
  assert.match(bad.text, /结果可能已经不准/)
  assert.match(bg.check('t1', ''), /回显/)
  assert.match(bg.check('t2', ''), /没有后台命令/)
})

test('命令没能启动（跑命令之前就抛错）：照样置终态并把失败推回，不留一条永远「运行中」的记录', async () => {
  const dir = repo()
  const { bg, got, all } = collect(1, {
    run: (() => {
      throw new Error('拼不出命令行')
    }) as never,
  })
  bg.start({ taskId: 't9', name: '起不来', command: 'echo hi', cwd: '', root: dir, exclusive: false })
  await all
  assert.equal(got[0].job.state, 'failed')
  assert.ok(got[0].job.endedAt, '记录要置终态，门禁和计划才不会一直等它')
  assert.match(got[0].text, /没能启动这条命令：拼不出命令行/)
})

test('独占命令按目录排队，一条跑完才开始下一条；cwd 不能跳出目录', async () => {
  const dir = repo()
  const { bg, got, all } = collect(2)
  // cmd 没有 sleep：用 node 等一会儿再写，命令行写法在 Windows 和 Unix 上一致
  const wait = nodeScript(dir, 'wait.cjs', "setTimeout(() => require('fs').appendFileSync('order.log', '1\\n'), 300)\n")
  bg.start({ taskId: 't1', name: '一', command: wait, cwd: '', root: dir, exclusive: true })
  const b = bg.start({ taskId: 't2', name: '二', command: 'echo 2 >> order.log', cwd: '', root: dir, exclusive: true })
  assert.match(b.info, /前面还有 1 条/)
  await all
  assert.deepEqual(
    got.map((g) => g.job.name),
    ['一', '二'],
  )
  assert.equal(
    bg.start({ taskId: 't1', name: 'x', command: 'true', cwd: '../..', root: dir, exclusive: false }).ok,
    false,
  )
})

test('停止对话时正在跑的会结束，排队的不再执行，也不再把结果推回对话', async () => {
  const dir = repo()
  const got: BgJob[] = []
  const bg = createBackground((job) => got.push(job))
  // 同上：cmd 没有 sleep，改成长时间不结束的 node 进程
  const long = nodeScript(dir, 'long.cjs', 'setTimeout(() => {}, 5000)\n')
  bg.start({ taskId: 't1', name: '长', command: long, cwd: '', root: dir, exclusive: true })
  bg.start({ taskId: 't1', name: '排队', command: 'echo no > never.txt', cwd: '', root: dir, exclusive: true })
  await new Promise((r) => setTimeout(r, 300))
  const t0 = Date.now()
  // 等进程真正退出才返回：调用方接着要删工作目录
  await bg.stop('t1')
  assert.ok(Date.now() - t0 < 4000)
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(got, [])
  assert.deepEqual(
    bg.list('t1').map((j) => [j.name, j.state]),
    [
      ['长', 'stopped'],
      ['排队', 'stopped'],
    ],
  )
  assert.equal(existsSync(path.join(dir, 'never.txt')), false)
  bg.forget('t1')
  assert.deepEqual(bg.list('t1'), [])
})

test('进程不退出（close 永远不来）：停止后记录先置终态，门禁不再拦', async () => {
  // 假 runner 永不 resolve，模拟孙进程握着 stdout、close 一直不来
  let started = false
  const never = () => {
    started = true
    return new Promise<never>(() => {})
  }
  // 兜底计时换成假时钟：推进时间才到点，不靠真实等待
  const clock = fakeClock()
  const { bg } = collect(1, { run: never, killGraceMs: 200, timers: clock.impl })
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-stuck-'))
  bg.start({ taskId: 't1', name: '卡住', command: 'npm test', cwd: '', root: dir, exclusive: false })
  // 等它真的跑起来：算指纹那一步也可能被 stop 拦住，那样测不到「close 不来」
  for (let i = 0; i < 40 && !started; i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(started, '命令已经开始跑')
  assert.equal(bg.list('t1')[0].state, 'running', '先算在执行中')

  const pending = () => bg.list('t1').filter((j) => j.state === 'queued' || j.state === 'running').length
  const task = { status: 'done' as const, working: false, requests: [], parentAsks: [], plans: [], steps: [] }
  assert.ok(childHoldsOf(task, { background: pending() }).includes('background'), '卡住时确实拦着')

  // stop 不能无限等一个不来的 close：上限到了就放，记录已经先置终态了
  const stopped = bg.stop('t1')
  await clock.advance(200)
  const job = bg.list('t1')[0]
  assert.equal(job.state, 'stopped', '记录先置终态')
  assert.match(job.lines.join('\n'), /进程未在 [\d.]+(ms|s) 内退出/)
  assert.equal(pending(), 0, '不再算还在跑')
  assert.ok(!childHoldsOf(task, { background: pending() }).includes('background'), '门禁放行')
  // close 永远不来：stop 靠上限（killGraceMs + 2000）放行，不再挂着调用方
  await clock.advance(2000)
  await stopped
  assert.deepEqual(clock.pending(), [], '没有残留的兜底定时器')
})

test('启动时清理上次遗留的记录：running / queued 都置终态，不再拦着完成', () => {
  const bg = createBackground(() => {})
  const now = new Date().toISOString()
  const stale: BgJob[] = [
    {
      id: 'old1',
      taskId: 't1',
      name: '旧编译',
      command: 'npm run build',
      cwd: '/x',
      exclusive: true,
      state: 'running',
      code: null,
      createdAt: now,
      startedAt: now,
      endedAt: '',
      lastOutputAt: now,
      timeoutMs: 60_000,
      lines: [],
      changed: false,
    },
    {
      id: 'old2',
      taskId: 't1',
      name: '排队的',
      command: 'npm test',
      cwd: '/x',
      exclusive: true,
      state: 'queued',
      code: null,
      createdAt: now,
      startedAt: '',
      endedAt: '',
      lastOutputAt: '',
      timeoutMs: 60_000,
      lines: [],
      changed: false,
    },
  ]
  assert.equal(bg.recover(stale), 2)
  for (const j of stale) {
    assert.equal(j.state, 'failed')
    assert.ok(j.endedAt)
    assert.match(j.lines.join('\n'), /面板上次退出时还没结束/)
  }
  // 已经终态的不再改一遍
  assert.equal(bg.recover(stale), 0)
})

test('全局名额：同时跑的后台命令有上限，多的排队；卡住的进程置终态后名额就还回来', async () => {
  let running = 0
  let peak = 0
  const finishers: (() => void)[] = []
  // 假 runner：不真的起进程，记下同时在跑的条数，由用例决定什么时候结束
  const fake = (() =>
    new Promise((resolve) => {
      running++
      peak = Math.max(peak, running)
      finishers.push(() => {
        running--
        resolve({ code: 0, killed: null, stderr: '' })
      })
    })) as unknown as NonNullable<Parameters<typeof createBackground>[1]>['run']
  const { bg, got } = collect(3, { run: fake, maxRunning: 2, killGraceMs: 50 })
  // 每条在不同的目录（像各个子对话的独立分支）：按目录排队拦不住，只能靠全局名额
  const dirs = [0, 1, 2].map((i) => mkdtempSync(path.join(tmpdir(), `bg-gate-${i}-`)))
  const infos = dirs.map(
    (root, i) => bg.start({ taskId: `t${i}`, name: `job${i}`, command: 'x', cwd: '', root, exclusive: false }).info,
  )
  for (let i = 0; i < 40 && running < 2; i++) await new Promise((r) => setTimeout(r, 25))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(running, 2, '只跑两条')
  assert.equal(bg.list('t2')[0].state, 'queued', '第三条排队')
  assert.match(infos[2], /同时最多跑 2 条/)
  // 停掉卡住的第一条：记录置终态就还名额，第三条马上开始，不用等 close
  void bg.stop('t0')
  for (let i = 0; i < 40 && bg.list('t2')[0].state !== 'running'; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(bg.list('t2')[0].state, 'running')
  // 第三条真正调到 runner（算完指纹）才有它的结束开关
  for (let i = 0; i < 40 && finishers.length < 3; i++) await new Promise((r) => setTimeout(r, 25))
  while (finishers.length) finishers.shift()!()
  for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 25))
  assert.ok(peak <= 3)
  assert.deepEqual(got.map((g) => g.job.name).sort(), ['job1', 'job2'])
})

test('上限从设置里取：每次排名额时重新读，改了马上生效', async () => {
  let limit = 1
  const finishers: (() => void)[] = []
  const fake = (() =>
    new Promise((resolve) =>
      finishers.push(() => resolve({ code: 0, killed: null, stderr: '' })),
    )) as unknown as NonNullable<Parameters<typeof createBackground>[1]>['run']
  const { bg, all } = collect(3, { run: fake, maxRunning: () => limit })
  const dirs = [0, 1, 2].map((i) => mkdtempSync(path.join(tmpdir(), `bg-limit-${i}-`)))
  bg.start({ taskId: 'a', name: 'a', command: 'x', cwd: '', root: dirs[0], exclusive: false })
  for (let i = 0; i < 40 && finishers.length < 1; i++) await new Promise((r) => setTimeout(r, 25))
  // 上限调大以后再来的两条马上一起跑，不用等第一条
  limit = 3
  bg.start({ taskId: 'b', name: 'b', command: 'x', cwd: '', root: dirs[1], exclusive: false })
  bg.start({ taskId: 'c', name: 'c', command: 'x', cwd: '', root: dirs[2], exclusive: false })
  for (let i = 0; i < 40 && finishers.length < 3; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(finishers.length, 3)
  while (finishers.length) finishers.shift()!()
  await all
})

test('监管：没输出、跑得久都提醒对话；停掉一条后记录置终态，发起它的那一行拿到真实用时', async () => {
  const clock = fakeClock()
  let t = 1_000_000
  let emit: (l: string) => void = () => {}
  let end: (r: { code: number; killed: null | 'stopped'; stderr: string }) => void = () => {}
  let started = false
  const fake = ((_line: string, _cwd: string, o: { onLine: (l: string) => void; signal?: AbortSignal }) =>
    new Promise((resolve) => {
      started = true
      emit = o.onLine
      end = resolve
      o.signal?.addEventListener('abort', () => resolve({ code: null, killed: 'stopped', stderr: '' }))
    })) as unknown as NonNullable<Parameters<typeof createBackground>[1]>['run']
  const notices: string[] = []
  const settled: BgJob[] = []
  const bg = createBackground(() => {}, {
    run: fake,
    timers: clock.impl,
    now: () => t,
    stallMs: 1000,
    checkFirstMs: 4000,
    killGraceMs: 100,
    onNotice: (_j, text) => notices.push(text),
    onSettle: (j) => settled.push({ ...j }),
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-watch-'))
  const r = bg.start({ taskId: 't1', name: '装浏览器', command: 'x', cwd: '', root: dir, exclusive: false })
  assert.match(r.info, /盯着它直到真正结束/)
  for (let i = 0; i < 40 && !started; i++) await new Promise((r) => setTimeout(r, 25))
  const step = async (ms: number) => {
    t += ms
    await clock.advance(ms)
  }
  // 一直有输出：不算卡住
  for (let i = 0; i < 4; i++) {
    emit(`下载 ${i * 25}%`)
    await step(500)
  }
  assert.equal(notices.length, 0, '有输出时不提醒')
  // 不再输出：过了 stallMs 提醒一次，不重复
  await step(1500)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /没有任何输出，可能卡住了/)
  assert.match(notices[0], /下载 75%/)
  await step(1500)
  assert.equal(notices.length, 1, '同一段沉默只提醒一次')
  // 有了新输出、跑到检查点：提醒看一眼进度
  for (let i = 0; i < 6; i++) {
    emit(`解压 ${i}`)
    await step(500)
  }
  assert.ok(
    notices.some((n) => /还没结束/.test(n)),
    '跑得久要提醒看一眼',
  )
  assert.match(bg.check('t1', r.id!), /运行中，已经跑了/)
  // 对话判断卡住了：停掉
  assert.equal(bg.stopOne('t1', 'nope').ok, false)
  assert.equal(bg.stopOne('t1', r.id!).ok, true)
  for (let i = 0; i < 40 && !settled.length; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(settled.length, 1, '置终态时通知一次')
  assert.equal(settled[0].state, 'stopped')
  void end
  assert.deepEqual(clock.pending(), [], '结束后不留监管计时')
})

test('限时：写了 timeout_minutes 就按它，超过上限按上限', () => {
  const bg = createBackground(() => {}, { run: (() => new Promise(() => {})) as never })
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-limit-'))
  const a = bg.start({ taskId: 't', name: 'a', command: 'x', cwd: '', root: dir, exclusive: false, timeoutMinutes: 5 })
  const b = bg.start({
    taskId: 't',
    name: 'b',
    command: 'x',
    cwd: '',
    root: dir,
    exclusive: false,
    timeoutMinutes: 9999,
  })
  const c = bg.start({ taskId: 't', name: 'c', command: 'x', cwd: '', root: dir, exclusive: false })
  const ms = (id?: string) => bg.list('t').find((j) => j.id === id)!.timeoutMs
  assert.equal(ms(a.id), 5 * 60_000)
  assert.equal(ms(b.id), 8 * 3600_000)
  assert.equal(ms(c.id), 2 * 3600_000)
  void bg.stop('t')
})

test('子任务起的命令记下它的步骤，父对话自己起的不带；发给界面的映射带上它', async () => {
  const bg = createBackground(() => {}, { run: (() => new Promise(() => {})) as never })
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-step-'))
  const a = bg.start({
    taskId: 't',
    step: '@chat/sub/h1',
    name: '子任务起的',
    command: 'x',
    cwd: '',
    root: dir,
    exclusive: false,
  })
  const b = bg.start({ taskId: 't', name: '父对话起的', command: 'x', cwd: '', root: dir, exclusive: false })
  const list = bg.list('t')
  assert.equal(list.find((j) => j.id === a.id)!.step, '@chat/sub/h1')
  assert.ok(!('step' in list.find((j) => j.id === b.id)!), '父对话自己起的不写 step，运行区据此分开列')
  // 界面上拿到的字段：子任务起的带 step，父对话起的不带；只列还在跑的
  const shown = uiJobs(list)
  assert.equal(shown.find((j) => j.id === a.id)!.step, '@chat/sub/h1')
  assert.ok(!('step' in shown.find((j) => j.id === b.id)!))
  assert.deepEqual(
    shown.map((j) => j.id),
    [a.id, b.id],
  )
  void bg.stop('t')
})

test('那一行收口：CLI 在结果前面插了说明也认得出，结果到了才算完成；不认识的编号收成「结果丢失」', async () => {
  const { settleJobRow, reapLostJobs } = await import('./background.ts')
  const { bgPendingIds, opensWindow } = await import('../shared/panel-tools.ts')
  const out =
    '<repair_note>Coerced string `exclusive` to a boolean.</repair_note>\n已放到后台（编号 fb0d6fa4）。面板盯着它直到真正结束。\n计划步骤「重跑检查」已标成等待中'
  const tool = { kind: 'other' as const, name: 'MCP', label: 'panel · run_background', detail: '', output: out, ms: 80 }
  const build = {
    kind: 'other' as const,
    name: 'MCP',
    label: 'panel · request_build',
    detail: '',
    output: '已申请编译（编译、打包），编号 1a2b3c4d、5e6f7a8b。编译目录空闲，马上开始。',
    ms: 10,
  }
  const task = { messages: [{ tools: [tool, build] }] } as unknown as Parameters<typeof settleJobRow>[0]
  assert.deepEqual(bgPendingIds(out), ['fb0d6fa4'], '前面插了 repair_note 也认得出编号')
  assert.equal(
    settleJobRow(task, 'fb0d6fa4', '【后台命令 fb0d6fa4 已结束】后台命令「检查」跑完了：成功', true, 95_000, ''),
    true,
  )
  assert.equal(tool.ms, 95_000, '记真实用时')
  assert.deepEqual(bgPendingIds(tool.output), [])
  assert.equal(settleJobRow(task, 'fb0d6fa4', 'x', true, 1, ''), false, '同一条不重复接')
  // 申请的编译有两条：第一条结束还在等第二条
  settleJobRow(task, '1a2b3c4d', '【后台命令 1a2b3c4d 已结束】后台命令「编译」跑完了：成功', true, 1000, '')
  assert.deepEqual(bgPendingIds(build.output), ['5e6f7a8b'])
  // 面板重启后不认识第二条：收成失败，不再转圈
  assert.equal(
    reapLostJobs(task, () => false),
    1,
  )
  assert.deepEqual(bgPendingIds(build.output), [])
  assert.equal((build as { failed?: boolean }).failed, true)
  assert.match(build.output, /结果没有拿到/)
  // 开窗口的写法被拦下
  assert.equal(opensWindow('npm run build && start cmd /k "npm test"'), true)
  assert.equal(opensWindow('npm start'), false)
  const bg = createBackground(() => {})
  const r = bg.start({
    taskId: 't',
    name: 'x',
    command: 'start "" cmd /c npm test',
    cwd: '',
    root: tmpdir(),
    exclusive: false,
  })
  assert.equal(r.ok, false)
  assert.match(r.info, /不要新开命令行窗口/)
})

test('按编号读一条后台命令：跑着能读到已输出的内容，跑完读得到最终输出和退出码', async () => {
  const dir = repo()
  const { bg, all } = collect(1)
  // 先输出一行再等着，好在它跑着的时候读一次
  const slow = nodeScript(
    dir,
    'slow.cjs',
    "console.log('first-line')\nsetTimeout(() => { console.log('last-line'); process.exit(0) }, 400)\n",
  )
  const started = bg.start({ taskId: 't1', name: '慢命令', command: slow, cwd: '', root: dir, exclusive: false })
  assert.ok(started.ok)
  const id = started.id!

  // 跑着：读得到状态和已经输出的内容（输出不进对话记录，界面窗口按这个编号自己拉）
  let view = bg.view('t1', id)
  for (let i = 0; i < 40 && !(view?.output ?? '').includes('first-line'); i++) {
    await new Promise((r) => setTimeout(r, 50))
    view = bg.view('t1', id)
  }
  assert.equal(view?.state, 'running')
  assert.equal(view?.name, '慢命令')
  assert.equal(view?.command, slow)
  assert.match(view!.output, /first-line/)
  assert.equal(view?.code, null, '还没结束时没有退出码')
  assert.equal(view?.endedAt, '')
  assert.ok(view?.startedAt, '带着开始时间，窗口里的计时要用')
  // 输出里不掺面板自己的话（推回对话的 jobOutput 才会写「跑完了」这些）
  assert.doesNotMatch(view!.output, /跑完了|后台命令「/)

  await all
  // 跑完：仍然读得到，带最终输出和退出码（用户可能过一阵才点开）
  view = bg.view('t1', id)
  assert.equal(view?.state, 'done')
  assert.equal(view?.code, 0)
  assert.match(view!.output, /first-line/)
  assert.match(view!.output, /last-line/)
  assert.ok(view?.endedAt, '结束后有结束时间')
})

test('后台命令只给发起它的对话读：跨 taskId、不存在的编号都读不到', async () => {
  const dir = repo()
  const { bg, all } = collect(1)
  const r = bg.start({ taskId: 't1', name: '回显', command: 'echo hello', cwd: '', root: dir, exclusive: false })
  assert.ok(r.ok)
  // 别的对话拿着这个编号也读不到（接口里当不存在处理）
  assert.equal(bg.view('t2', r.id!), null)
  assert.equal(bg.view('t1', 'no-such-job'), null)
  await all
  assert.equal(bg.view('t2', r.id!), null, '结束以后也不给别的对话读')
  assert.ok(bg.view('t1', r.id!))
})
