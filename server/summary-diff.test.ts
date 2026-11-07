import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { attachCode } from './summary-diff.ts'
import type { DayProject, DayTask } from '../shared/summary.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** 建一个临时仓库，提交两次，返回两次的树：和每轮记下的快照区间一样是树哈希 */
function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-summary-diff-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src/nav.ts'), 'export const atBottom = () => true\n')
  writeFileSync(path.join(dir, 'src/nav.test.ts'), 'test1\n')
  writeFileSync(path.join(dir, 'README.md'), '# a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'a')
  const from = git(dir, 'rev-parse', 'HEAD^{tree}')
  writeFileSync(path.join(dir, 'src/nav.ts'), 'export const atBottom = (s: boolean) => s\n')
  writeFileSync(path.join(dir, 'src/nav.test.ts'), 'test2\n')
  writeFileSync(path.join(dir, 'README.md'), '# b\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'b')
  return { dir, from, to: git(dir, 'rev-parse', 'HEAD^{tree}') }
}

const task = (over: Partial<DayTask>): DayTask => ({
  id: 't',
  title: '',
  status: 'done',
  asks: [],
  outcomes: [],
  cards: [],
  reply: '',
  steps: [],
  files: [],
  at: '',
  userBug: false,
  fixCard: false,
  spans: [],
  code: '',
  ...over,
})

test('attachCode：只给可能在修 Bug 的对话带代码改动，测试和文档不放；读不出的区间跳过不报错', async () => {
  const { dir, from, to } = repo()
  try {
    const projects: DayProject[] = [
      {
        projectId: 'p',
        projectName: '面板',
        tasks: [
          task({ id: 'bug', userBug: true, spans: [{ from, to }] }),
          task({ id: 'fix-card', fixCard: true, spans: [{ from, to }] }),
          task({ id: 'need', spans: [{ from, to }] }),
          task({ id: 'gone', userBug: true, spans: [{ from: 'deadbeef', to }] }),
        ],
      },
    ]
    await attachCode(projects, () => dir)
    const [bug, card, need, gone] = projects[0].tasks
    assert.match(bug.code, /^diff --git a\/src\/nav\.ts/)
    assert.match(bug.code, /\+export const atBottom = \(s: boolean\) => s/)
    assert.doesNotMatch(bug.code, /nav\.test\.ts|README\.md/, '测试和文档不放进材料')
    assert.equal(card.code, bug.code, '写了「修复」总结卡的也给')
    assert.equal(need.code, '', '需求不贴代码，不给改动')
    assert.equal(gone.code, '', '快照没了读不出来：不给，也不让整次提炼失败')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
