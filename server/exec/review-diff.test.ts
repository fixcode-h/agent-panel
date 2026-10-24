import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reviewDiff } from './git.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-review-'))
  git(dir, 'init', '-q')
  writeFileSync(
    path.join(dir, 'a.ts'),
    'export function a() {\n  return 1\n}\n\nexport function b() {\n  return 2\n}\n',
  )
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() }
}

test('评审的改动：带着整个函数的差异和没跟踪的新文件，不碰暂存区', async () => {
  const { dir, base } = repo()
  writeFileSync(
    path.join(dir, 'a.ts'),
    'export function a() {\n  return 10\n}\n\nexport function b() {\n  return 2\n}\n',
  )
  writeFileSync(path.join(dir, 'new.ts'), 'export const n = 1\n')
  const d = (await reviewDiff(dir, base))!
  assert.ok(d.snapshot)
  assert.match(d.stat, /a\.ts/)
  assert.match(d.stat, /new\.ts/, '没跟踪的新文件也算')
  assert.match(d.diff, /export function a\(\) \{/, '带上改动所在的整个函数')
  assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), '', '真正的暂存区不变')
})

test('评审的改动：给了上一轮的快照就只取那之后的增量', async () => {
  const { dir, base } = repo()
  writeFileSync(
    path.join(dir, 'a.ts'),
    'export function a() {\n  return 10\n}\n\nexport function b() {\n  return 2\n}\n',
  )
  const first = (await reviewDiff(dir, base))!
  writeFileSync(path.join(dir, 'fix.ts'), 'export const f = 1\n')
  const again = (await reviewDiff(dir, base, first.snapshot))!
  assert.match(again.stat, /fix\.ts/)
  assert.doesNotMatch(again.stat, /a\.ts/, '上一轮看过的改动不再带')
  const none = (await reviewDiff(dir, base, again.snapshot))!
  assert.equal(none.stat, '', '没有新改动')
})
