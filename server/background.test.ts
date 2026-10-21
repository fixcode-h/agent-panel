import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBackground, type BgJob } from './background.ts'

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bg-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return dir
}

/** 收集跑完的结果，等到够数为止 */
function collect(n: number) {
  const got: { job: BgJob; text: string }[] = []
  let done: () => void = () => {}
  const all = new Promise<void>((r) => (done = r))
  const bg = createBackground((job, text) => {
    got.push({ job, text })
    if (got.length === n) done()
  })
  return { bg, got, all }
}

test('后台命令马上返回，跑完把结果推回；跑的期间文件变了要提醒', async () => {
  const dir = repo()
  const { bg, got, all } = collect(2)
  const a = bg.start({ taskId: 't1', name: '回显', command: 'echo hello', cwd: '', root: dir, exclusive: false })
  assert.ok(a.ok)
  assert.match(a.info, /已放到后台/)
  bg.start({ taskId: 't1', name: '改文件', command: 'echo two > a.txt; exit 3', cwd: '', root: dir, exclusive: false })
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
  bg.start({ taskId: 't1', name: '一', command: 'sleep 0.3; echo 1 >> order.log', cwd: '', root: dir, exclusive: true })
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

test('停止对话时正在跑的会结束，排队的不再执行', async () => {
  const dir = repo()
  const { bg, got, all } = collect(1)
  bg.start({ taskId: 't1', name: '长', command: 'sleep 5', cwd: '', root: dir, exclusive: true })
  bg.start({ taskId: 't1', name: '排队', command: 'echo no > never.txt', cwd: '', root: dir, exclusive: true })
  await new Promise((r) => setTimeout(r, 300))
  bg.stop('t1')
  await all
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(
    got.map((g) => [g.job.name, g.job.state]),
    [['长', 'stopped']],
  )
  assert.equal(existsSync(path.join(dir, 'never.txt')), false)
})
