import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bugSource } from './bug-source.ts'

// 用户 2026-11-11 报：P4 工程（不是 git）修复页把改过的文件整个画成新增。
// 不是 git 工作区时 diff 返回 undefined（由调用方改用 Agent 记下的改动），不和空文件比
test('不是 git 工作区：diff 取不到，不退回和空文件比', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-bugsrc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 临时目录可能落在某个 git 仓库里：上限设到它自己，保证它不是 git 工作区
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir)
  t.after(() => delete process.env.GIT_CEILING_DIRECTORIES)
  writeFileSync(path.join(dir, 'a.lua'), 'local a = 1\nreturn a\n')
  assert.equal(bugSource(dir)!.diff!('a.lua'), undefined)
  assert.equal(bugSource(dir)!.read('a.lua'), 'local a = 1\nreturn a\n')
})

test('git 工作区：跟踪的文件和开始时比，没跟踪的新文件和空文件比', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-bugsrc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(path.join(dir, 'a.lua'), 'local a = 1\nreturn a\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  writeFileSync(path.join(dir, 'a.lua'), 'local a = 2\nreturn a\n')
  writeFileSync(path.join(dir, 'b.lua'), 'return 1\n')
  const src = bugSource(dir)!
  const a = src.diff!('a.lua')!
  assert.match(a, /^-local a = 1$/m)
  assert.match(a, /^\+local a = 2$/m)
  assert.match(src.diff!('b.lua')!, /^\+return 1$/m)
})

// 用户 2026-11-13 报：Agent 自己读的大日志没地方引用，塞进描述里。按行号只取那几行，大文件也能取
test('按行号取日志文件的那几行：CRLF 归一、末尾换行不多算一行、越界返回空', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-bugsrc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'game.log'), 'l1\r\nl2\r\nl3 中文\r\nl4\r\n')
  const src = bugSource(dir)!
  assert.deepEqual(src.lines!('game.log', 2, 3), { text: 'l2\nl3 中文', total: 4 })
  assert.deepEqual(src.lines!('game.log', 1, 1), { text: 'l1', total: 4 })
  assert.deepEqual(src.lines!('game.log', 4, 9), { text: 'l4', total: 4 })
  assert.equal(src.lines!('game.log', 6, 6)!.text, '')
  assert.equal(src.lines!('nope.log', 1, 1), undefined)
})
