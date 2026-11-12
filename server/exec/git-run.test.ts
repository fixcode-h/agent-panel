import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gitExec, gitRaw, gitRun, gitSync } from './git.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-git-run-'))
  git(dir, 'init', '-q')
  writeFileSync(path.join(dir, '中文.txt'), 'a\r\nb\r\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

test('四种 git 调用都带 core.quotepath=off：中文文件名原样输出，不写成 "\\346…" 转义', async (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 对照：不带这个参数时 git 默认会转义，证明下面断言测到了东西
  assert.match(git(dir, 'ls-files'), /\\\d{3}/)

  assert.equal((await gitRun(dir, ['ls-files'])).stdout.trim(), '中文.txt')
  assert.equal((await gitRaw(dir, ['ls-files'])).stdout.toString('utf8').trim(), '中文.txt')
  assert.equal((await gitExec(dir, ['ls-files'])).stdout.trim(), '中文.txt')
  assert.equal(gitSync(dir, ['ls-files'])?.out.trim(), '中文.txt')
})

test('gitExec 原样给文本（CRLF 不丢），失败时抛错且错误上带输出；gitRun / gitSync 失败不抛，看退出码', async (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal((await gitExec(dir, ['show', 'HEAD:中文.txt'])).stdout, 'a\r\nb\r\n')

  const err = (await gitExec(dir, ['rev-parse', '--verify', 'nope']).catch((e: unknown) => e)) as {
    stderr?: string
  }
  assert.ok(err instanceof Error)
  assert.equal(typeof err.stderr, 'string')
  assert.notEqual((await gitRun(dir, ['rev-parse', '--verify', 'nope'])).code, 0)
  assert.notEqual(gitSync(dir, ['rev-parse', '--verify', 'nope'])?.code, 0)
  // 目录不存在：同步版跑不起来返回 undefined，调用方当「取不到」
  assert.equal(gitSync(path.join(dir, 'missing'), ['status']), undefined)
})

test('workTree：显式指定工作区，.git/config 里的 core.worktree 写坏了也能跑', async (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'config', 'core.worktree', '/mnt/not-here')
  assert.notEqual((await gitRun(dir, ['status', '--porcelain'])).code, 0)
  const r = await gitRun(dir, ['status', '--porcelain'], { workTree: dir })
  assert.equal(r.code, 0)
})
