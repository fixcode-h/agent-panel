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

test('评审的改动：每处改动带前后几行和没跟踪的新文件，不碰暂存区', async () => {
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
  assert.match(d.diff, /export function a\(\) \{/, '带上改动前后几行，看得出改在哪个函数')
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

test('评审的改动：只取点名的文件，锁文件只在列表里不进差异正文', async () => {
  const { dir, base } = repo()
  writeFileSync(
    path.join(dir, 'a.ts'),
    'export function a() {\n  return 10\n}\n\nexport function b() {\n  return 2\n}\n',
  )
  writeFileSync(path.join(dir, 'other.ts'), 'export const o = 1\n')
  writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3}\n')
  const scoped = (await reviewDiff(dir, base, '', ['a.ts', 'package-lock.json']))!
  assert.doesNotMatch(scoped.stat, /other\.ts/, '没点名的文件不带')
  assert.match(scoped.stat, /package-lock\.json/, '锁文件列在文件清单里')
  assert.doesNotMatch(scoped.diff, /lockfileVersion/, '锁文件不进差异正文')
  assert.match(scoped.diff, /return 10/)
  const none = (await reviewDiff(dir, base, '', []))!
  assert.equal(none.stat, '', '点名了却一个文件都没有就是没有改动')
})
