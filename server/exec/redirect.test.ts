/**
 * 新消息打断命令的时机：只读命令等自然跑完，会写东西的命令才按短阈值停。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOnlyCommand, redirectWait } from './redirect.ts'

test('只读命令：列目录、搜代码、看 git 历史和状态', () => {
  for (const cmd of [
    'ls -la',
    'cat README.md',
    'rg -n "redirect" server/exec',
    'git worktree list',
    'git worktree list --porcelain',
    'git log -p -n 10 -- server/exec',
    'git status --short',
    'git diff HEAD~1',
    'git branch -a',
    'git remote -v',
    'git config --get user.name',
    'git stash list',
    '  git show HEAD --stat  ',
  ])
    assert.equal(readOnlyCommand(cmd), true, cmd)
})

test('会写东西、跑测试、等外部状态的命令不当只读', () => {
  for (const cmd of [
    'sleep 120; gh pr checks 14',
    'npm ci',
    'npm run test:unit',
    'node scripts/e2e.mjs',
    'git commit -m "x"',
    'git push origin dev',
    'git branch -D feat',
    'git tag v1.0.0',
    'git remote add origin https://example.com/x.git',
    'git config user.name x',
    'git worktree add ../wt',
    'git stash',
    'rm -rf node_modules',
    'ls > out.txt',
    'ls && rm -rf build',
    'find . -name "*.log" -delete',
    'sed -i "s/a/b/" file.ts',
    'sudo ls',
    'bash -lc "npm run build"',
    '',
  ])
    assert.equal(readOnlyCommand(cmd), false, cmd)
})

test('只读命令还在跑：继续等它自己结束，不马上打断', () => {
  const now = 10_000
  const wait = redirectWait([{ kind: 'run', label: 'git worktree list', startedAt: now - 1000 }], now, {
    command: 8000,
    readOnly: 40_000,
  })
  assert.equal(wait, 39_000)
})

test('会写东西的命令跑了超过阈值：马上停', () => {
  const now = 10_000
  const wait = redirectWait([{ kind: 'run', label: 'npm run test:unit', startedAt: now - 9000 }], now, {
    command: 8000,
    readOnly: 40_000,
  })
  assert.ok(wait !== undefined && wait <= 0)
})

test('只读命令卡住了（超过兜底阈值）：也停', () => {
  const now = 100_000
  const wait = redirectWait([{ kind: 'run', label: 'rg --files .', startedAt: now - 45_000 }], now, {
    command: 8000,
    readOnly: 40_000,
  })
  assert.ok(wait !== undefined && wait < 0)
})

test('只读和会写东西的命令同时在跑：按最先到期的那个停', () => {
  const now = 10_000
  const wait = redirectWait(
    [
      { kind: 'run', label: 'git log -p -n 10', startedAt: now - 5000 },
      { kind: 'run', label: 'npm ci', startedAt: now - 9000 },
    ],
    now,
    { command: 8000, readOnly: 40_000 },
  )
  assert.ok(wait !== undefined && wait <= 0)
})

test('没有命令在跑（读文件、改文件）：不用计时', () => {
  assert.equal(
    redirectWait([{ kind: 'read', label: 'README.md', startedAt: 0 }], 10_000, { command: 8000, readOnly: 40_000 }),
    undefined,
  )
  assert.equal(redirectWait([], 10_000, { command: 8000, readOnly: 40_000 }), undefined)
})
