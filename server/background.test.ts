import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBackground, type BgJob } from './background.ts'
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
  const { bg } = collect(1, { run: never, killGraceMs: 200 })
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-stuck-'))
  bg.start({ taskId: 't1', name: '卡住', command: 'npm test', cwd: '', root: dir, exclusive: false })
  // 等它真的跑起来：算指纹那一步也可能被 stop 拦住，那样测不到「close 不来」
  for (let i = 0; i < 40 && !started; i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(started, '命令已经开始跑')
  assert.equal(bg.list('t1')[0].state, 'running', '先算在执行中')
  const t0 = Date.now()

  const pending = () => bg.list('t1').filter((j) => j.state === 'queued' || j.state === 'running').length
  const task = { status: 'done' as const, working: false, requests: [], parentAsks: [], plans: [], steps: [] }
  assert.ok(childHoldsOf(task, { background: pending() }).includes('background'), '卡住时确实拦着')

  // stop 不能无限等进程：上限到了就放，记录已经先置终态了
  await bg.stop('t1')
  assert.ok(Date.now() - t0 < 4000, '停止不会挂死调用方')
  const job = bg.list('t1')[0]
  assert.equal(job.state, 'stopped', '记录先置终态')
  assert.match(job.lines.join('\n'), /进程未在 \d+ 秒内退出/)
  assert.equal(pending(), 0, '不再算还在跑')
  assert.ok(!childHoldsOf(task, { background: pending() }).includes('background'), '门禁放行')
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
      startedAt: now,
      endedAt: '',
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
      startedAt: '',
      endedAt: '',
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
