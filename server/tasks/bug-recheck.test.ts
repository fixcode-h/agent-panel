import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setLang } from '../../shared/i18n.ts'
import { Diagnosis } from '../../shared/bug-diagnosis-schema.ts'
import { recheckVerdict } from '../../shared/bug-recheck.ts'
import type { Task } from '../../shared/schema.ts'
import { recheck } from './bug-recheck.ts'

/**
 * 面板复核回归测试（分析稿 B9）：真的开一个 Git 仓库，改前在对话开始时的提交上（带上现在新写的测试）跑、
 * 改后在现在的代码上跑，按退出码判；跑完临时工作区收干净，不留在仓库的 worktree 列表里
 */
setLang('zh')

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recheck-test-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  writeFileSync(path.join(dir, 'calc.js'), 'module.exports = (a, b) => a - b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  const base = git(dir, 'rev-parse', 'HEAD')
  // 修复：改了源码，新写了回归测试（改前还不存在，复核时要拷进改前的工作区）
  writeFileSync(path.join(dir, 'calc.js'), 'module.exports = (a, b) => a + b\n')
  mkdirSync(path.join(dir, 'tests'))
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.js'),
    "const add = require('../calc.js')\nif (add(1, 2) !== 3) { console.log('add 错了'); process.exit(1) }\nconsole.log('ok')\n",
  )
  return { dir, base }
}

const fixVersion = (commands: string[]) =>
  Diagnosis.parse({
    version: 3,
    at: 'x',
    phase: 'fix',
    status: 'pending',
    result: { commands, regressionTests: ['tests/calc.test.js'] },
  })

const taskWith = (base: string, commands: string[]) =>
  ({
    baseRef: base,
    messages: [{ tools: commands.map((c) => ({ kind: 'run', label: c, detail: '' })) }],
  }) as unknown as Task

test('改前在开始时的提交上（带上现在的测试）跑、改后在现在的代码上跑：改前失败、改后通过', async () => {
  const { dir, base } = repo()
  try {
    const cmd = 'node tests/calc.test.js'
    const r = await recheck(taskWith(base, [cmd]), fixVersion([cmd]), dir)
    assert.equal(r.state, 'done')
    const x = r.items[0]
    assert.equal(x.before?.code, 1, x.before?.out + x.before!.error)
    assert.match(x.before!.out, /add 错了/)
    assert.equal(x.after?.code, 0)
    assert.match(x.after!.out, /ok/)
    assert.equal(recheckVerdict(r), 'pass')
    // 临时工作区收干净：仓库里只剩自己这一个工作区
    assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('对话里没跑过的命令不替它跑；取不到改前的代码照实写原因，改后照跑', async () => {
  const { dir, base } = repo()
  try {
    const cmd = 'node tests/calc.test.js'
    const never = await recheck(taskWith(base, []), fixVersion([cmd]), dir)
    // 读设置时界面语言可能被换成英文：两种说法都认
    assert.match(never.items[0].skip, /没在对话里跑过|never run/)
    assert.equal(never.items[0].after, undefined)
    const noBase = await recheck(taskWith('', [cmd]), fixVersion([cmd]), dir)
    assert.match(noBase.items[0].before!.error, /取不到改前的代码|unavailable/)
    assert.equal(noBase.items[0].after?.code, 0)
    assert.equal(recheckVerdict(noBase), 'partial')
    assert.ok(!existsSync(path.join(dir, 'base')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('命令有超时：跑不完的停掉，记成超时，不算通过也不算失败', async () => {
  const { dir, base } = repo()
  const old = process.env.AGENT_PANEL_RECHECK_TIMEOUT_MS
  process.env.AGENT_PANEL_RECHECK_TIMEOUT_MS = '500'
  try {
    const cmd = 'node -e "setTimeout(() => {}, 10000)"'
    const r = await recheck(taskWith(base, [cmd]), fixVersion([cmd]), dir)
    assert.equal(r.items[0].after?.timedOut, true)
    assert.equal(recheckVerdict(r), 'partial')
  } finally {
    if (old === undefined) delete process.env.AGENT_PANEL_RECHECK_TIMEOUT_MS
    else process.env.AGENT_PANEL_RECHECK_TIMEOUT_MS = old
    rmSync(dir, { recursive: true, force: true })
  }
})
