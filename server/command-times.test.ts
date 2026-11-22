/**
 * 按项目记前台命令的用时，跑过一分钟以上的下次放后台（server/command-times.ts）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'cmd-times-'))
const { knownSlow, noteCommandTime, resetCommandTimes } = await import('./command-times.ts')

test('跑过一分钟以上的才算慢；按项目分开；分不清哪段慢的整条不记', () => {
  resetCommandTimes()
  noteCommandTime('p1', 'cd web && npm run build', 90_000)
  noteCommandTime('p1', 'npm run lint', 5_000)
  noteCommandTime('p1', 'npm ci && npm run test', 200_000)
  assert.equal(knownSlow('p1', 'npm run build -- --mode demo'), 90_000)
  assert.equal(knownSlow('p1', 'npm run lint'), undefined)
  assert.equal(knownSlow('p1', 'npm run test'), undefined)
  assert.equal(knownSlow('p2', 'npm run build'), undefined)
  // 后来变快了：按最近一次算
  noteCommandTime('p1', 'npm run build', 3_000)
  assert.equal(knownSlow('p1', 'npm run build'), undefined)
})

test('多行引号正文、子 shell 括号、shell 关键字不当成命令名记', () => {
  resetCommandTimes()
  noteCommandTime('p3', 'git commit -m "改了 quote\n\nb\nCo-Authored-By: Claude Code"', 90_000)
  assert.equal(knownSlow('p3', 'b'), undefined)
  assert.equal(knownSlow('p3', 'co-authored-by: claude code'), undefined)
  noteCommandTime('p3', 'node -e "const x = 1\nfunction taskChanges(n) { return 30 }\nconsole.log(x)"', 90_000)
  assert.equal(knownSlow('p3', 'function taskChanges 30'), undefined)
  noteCommandTime('p3', '( cd web && make dist )', 90_000)
  assert.equal(knownSlow('p3', '('), undefined)
  assert.equal(knownSlow('p3', 'make dist'), 90_000)
})
