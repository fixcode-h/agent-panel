/**
 * 一轮结束时「动手了几次」：只读命令不算（摸底报告第 18 条：只读问答跑几条 rg 就被收尾自检再推一轮）。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changedSomething, turnInfo } from './turn-info.ts'

const run = (label: string) => ({ kind: 'run' as const, name: 'Bash', label, detail: '' })

test('只读命令不算动手，改文件和认不出的命令照旧算', () => {
  assert.equal(changedSomething(run('rg -n foo src')), false)
  assert.equal(changedSomething(run('git log --oneline -5 | head')), false)
  assert.equal(changedSomething(run('npm install')), true)
  assert.equal(changedSomething(run('rm -rf dist')), true)
  assert.equal(changedSomething({ kind: 'edit', name: 'Edit', label: 'a.ts' }), true)
  const msgs = [{ tools: [run('rg foo'), run('cat a.ts'), run('grep -n x b.ts'), run('npm test')] }] as never
  assert.equal(turnInfo(4, msgs).acts, 1)
})
