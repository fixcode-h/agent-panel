import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPatch, loadPatch, restorePatch } from './bug-patch.ts'
import { fetchWatch, startWatch } from './bug-log-watch.ts'
import { collectBugEnv } from '../exec/bug-env.ts'

/** 取证（分析稿 B1 / B3 / B4）的服务端：真的 git 仓库和独立分支、真的日志文件，放在系统临时目录 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ap-evidence-'))
  const project = path.join(root, 'project')
  mkdirSync(project)
  git(project, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(project, 'a.ts'), 'function pay() {\n  const total = 1\n  return total\n}\n')
  writeFileSync(path.join(project, 'b.ts'), 'export const b = 1\n')
  writeFileSync(path.join(project, 'package-lock.json'), '{}\n')
  git(project, 'add', '.')
  git(project, 'commit', '-qm', '第一次提交')
  const base = git(project, 'rev-parse', 'HEAD').trim()
  const wt = path.join(root, 'wt')
  git(project, 'worktree', 'add', '-q', '-b', 'ap/bug', wt)
  // 子对话在独立分支里加了临时日志（没提交）
  writeFileSync(
    path.join(wt, 'a.ts'),
    "function pay() {\n  const total = 1\n  console.log('[排查-支付] L1 total=', total)\n  return total\n}\n",
  )
  const dirs = { wt, project, baseRef: base, baseBranch: 'main', stateDir: path.join(root, 'state') }
  return { root, dirs, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('排查补丁：放之前拍快照、打到项目目录，还原后和快照一模一样', async () => {
  const r = repo()
  try {
    const before = readFileSync(path.join(r.dirs.project, 'a.ts'), 'utf8')
    const put = await applyPatch(r.dirs, 'logs', ['a.ts', 'b.ts'])
    assert.ok(put.ok, put.reason)
    // b.ts 补丁没碰到：不记、不动
    assert.deepEqual(put.files, ['a.ts'])
    assert.match(readFileSync(path.join(r.dirs.project, 'a.ts'), 'utf8'), /\[排查-支付\] L1/)
    // 再放一次不行：先还原
    assert.equal((await applyPatch(r.dirs, 'logs', ['a.ts'])).ok, false)
    const back = await restorePatch(r.dirs)
    assert.ok(back.ok, back.reason)
    assert.equal(readFileSync(path.join(r.dirs.project, 'a.ts'), 'utf8'), before)
    assert.equal(await loadPatch(r.dirs.stateDir), undefined)
  } finally {
    r.done()
  }
})

test('排查补丁：项目目录里这几个文件有冲突的未提交改动时什么都不动，说明为什么', async () => {
  const r = repo()
  try {
    const mine = 'function pay() {\n  const total = 2 // 我改的\n  return total\n}\n'
    writeFileSync(path.join(r.dirs.project, 'a.ts'), mine)
    const put = await applyPatch(r.dirs, 'logs', ['a.ts'])
    assert.equal(put.ok, false)
    assert.match(put.reason, /对不上/)
    assert.deepEqual(put.files, ['a.ts'])
    assert.equal(readFileSync(path.join(r.dirs.project, 'a.ts'), 'utf8'), mine)
    assert.equal(await loadPatch(r.dirs.stateDir), undefined)
  } finally {
    r.done()
  }
})

test('排查补丁：放了之后用户又改过的文件不覆盖，新建的文件还原时删掉', async () => {
  const r = repo()
  try {
    writeFileSync(path.join(r.dirs.wt, 'probe.ts'), "console.log('[排查-支付] L2')\n")
    const put = await applyPatch(r.dirs, 'logs', ['a.ts', 'probe.ts'])
    assert.ok(put.ok, put.reason)
    assert.ok(existsSync(path.join(r.dirs.project, 'probe.ts')))
    appendFileSync(path.join(r.dirs.project, 'a.ts'), '// 我又加了一行\n')
    const busy = await restorePatch(r.dirs)
    assert.equal(busy.ok, false)
    assert.deepEqual(busy.files, ['a.ts'])
    assert.ok(existsSync(path.join(r.dirs.project, 'probe.ts')), '有冲突时一个文件都不动')
    // 用户撤掉自己的改动后再还原：新建的文件删掉，a.ts 回到原样
    git(r.dirs.project, 'checkout', '--', 'a.ts')
    writeFileSync(path.join(r.dirs.project, 'a.ts'), readFileSync(path.join(r.dirs.wt, 'a.ts')))
    const back = await restorePatch(r.dirs)
    assert.ok(back.ok, back.reason)
    assert.ok(!existsSync(path.join(r.dirs.project, 'probe.ts')))
    assert.equal(git(r.dirs.project, 'status', '--porcelain'), '')
  } finally {
    r.done()
  }
})

test('取日志：开始复现记下大小，取回新增部分；项目外的文件要确认，相对路径跑出去的拒绝', async () => {
  const r = repo()
  const outside = mkdtempSync(path.join(os.tmpdir(), 'ap-outside-'))
  try {
    const dirs = { project: r.dirs.project, work: r.dirs.wt, stateDir: path.join(r.root, 'log') }
    const log = path.join(r.dirs.project, 'logs', 'app.log')
    mkdirSync(path.dirname(log))
    writeFileSync(log, 'old line\n')
    assert.equal((await fetchWatch('logs/app.log', dirs, false)).ok, false, '没点开始不能取')
    const s = await startWatch('日志在 logs/app.log', dirs, false)
    assert.ok(s.ok && s.size === 9 && !s.missing)
    appendFileSync(log, 'noise\n[排查-支付] L1 total=1\nmore\n')
    const f = await fetchWatch('日志在 logs/app.log', dirs, false)
    assert.ok(f.ok)
    assert.equal(f.text, 'noise\n[排查-支付] L1 total=1\nmore\n')
    assert.equal(f.related, '[排查-支付] L1 total=1')
    assert.ok(!f.truncated && !f.rotated)

    assert.equal((await startWatch('浏览器控制台', dirs, false)).ok, false)
    const up = await startWatch('../../etc/app.log', dirs, false)
    assert.ok(!up.ok && !up.needConfirm)
    // 项目里的链接指向外面：按外面算，相对路径写的不读
    writeFileSync(path.join(outside, 'x.log'), 'secret\n')
    symlinkSync(path.join(outside, 'x.log'), path.join(r.dirs.project, 'link.log'))
    const viaLink = await startWatch('link.log', dirs, false)
    assert.ok(!viaLink.ok && !viaLink.needConfirm)
    // 报告里明确写的绝对路径在外面：要用户确认
    const abs = path.join(outside, 'x.log')
    const ask = await startWatch(abs, dirs, false)
    assert.ok(!ask.ok && ask.needConfirm)
    assert.ok((await startWatch(abs, dirs, true)).ok)
  } finally {
    r.done()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('环境：从项目目录取分支、最近提交、未提交改动、锁文件最近一次改动；不是 Git 仓库的只有系统信息', () => {
  const r = repo()
  const plain = mkdtempSync(path.join(os.tmpdir(), 'ap-plain-'))
  try {
    writeFileSync(path.join(r.dirs.project, 'b.ts'), 'export const b = 2\n')
    const env = collectBugEnv(r.dirs.project, { cli: 'Claude Code', model: 'm1' })
    assert.equal(env.branch, 'main')
    assert.equal(env.commits.length, 1)
    assert.equal(env.commits[0].title, '第一次提交')
    assert.deepEqual(env.dirty, ['b.ts'])
    assert.equal(env.lock?.file, 'package-lock.json')
    assert.equal(env.lock?.title, '第一次提交')
    assert.equal(env.cli, 'Claude Code')
    assert.ok(env.os && env.node)
    const none = collectBugEnv(plain, { cli: '', model: '' })
    assert.equal(none.branch, '')
    assert.deepEqual(none.commits, [])
    assert.ok(none.os)
  } finally {
    r.done()
    rmSync(plain, { recursive: true, force: true })
  }
})
