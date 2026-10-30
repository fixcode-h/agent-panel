import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUDGET_ITEMS,
  countDelta,
  diffCases,
  newCaseVerdict,
  newCasesInSource,
  parseBudgetNote,
  pendingTestChanges,
} from './test-budget.mjs'

test('新增判定：只拦净新增，改名、合并、删除都放行；净新增时要有非空的「测试预算:」段', () => {
  const c = (text) => ({ file: 'server/a.test.ts', line: 1, text })
  // 改名：删一条加一条，净新增 0
  assert.deepEqual(newCaseVerdict({ added: [c('新名')], removed: [c('旧名')] }), { net: 0, ok: true })
  // 两条合成一条：净新增 -1
  assert.deepEqual(newCaseVerdict({ added: [c('合并后')], removed: [c('甲'), c('乙')] }), { net: -1, ok: true })
  // 真的多了：没写理由拦下，写了放行
  assert.equal(newCaseVerdict({ added: [c('新的')] }).ok, false)
  const note = parseBudgetNote('改进：加用例\n\n测试预算:\n- 覆盖空消息这条以前没有用例的路径\n\n修复：别的东西')
  assert.equal(note, '测试预算:\n- 覆盖空消息这条以前没有用例的路径')
  assert.equal(newCaseVerdict({ added: [c('新的')], note }).ok, true)
  // 只写前缀的空段不算理由
  assert.equal(parseBudgetNote('改进：x\n\n测试预算:\n\n修复：y'), '')
  assert.equal(parseBudgetNote(''), '')
})

test('新增判定：从 diff 里分出新增和删掉的用例，只认测试文件，e2e 分片数 step(', () => {
  const diff = [
    'diff --git a/server/exec/hints.test.ts b/server/exec/hints.test.ts',
    '--- a/server/exec/hints.test.ts',
    '+++ b/server/exec/hints.test.ts',
    '@@ -10,2 +11,3 @@',
    "-test('旧名', () => {})",
    "-  it('合进去的', () => {})",
    "+test('新名', () => {})",
    '+  // 注释不算',
    "+  it('新增二', () => {})",
    'diff --git a/scripts/e2e/03-chat.mjs b/scripts/e2e/03-chat.mjs',
    '--- a/scripts/e2e/03-chat.mjs',
    '+++ b/scripts/e2e/03-chat.mjs',
    '@@ -5,0 +6,1 @@',
    "+  step('新步骤')",
    'diff --git a/server/runner.ts b/server/runner.ts',
    '--- a/server/runner.ts',
    '+++ b/server/runner.ts',
    '@@ -1,0 +1,1 @@',
    "+test('不是测试文件，不算', () => {})",
    'diff --git a/server/gone.test.ts b/server/gone.test.ts',
    '--- a/server/gone.test.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    "-test('删掉的文件', () => {})",
  ].join('\n')
  const { added, removed } = diffCases(diff)
  assert.deepEqual(
    added.map((x) => [x.file, x.line, x.text]),
    [
      ['server/exec/hints.test.ts', 11, "test('新名', () => {})"],
      ['server/exec/hints.test.ts', 13, "it('新增二', () => {})"],
      ['scripts/e2e/03-chat.mjs', 6, "step('新步骤')"],
    ],
  )
  assert.deepEqual(
    removed.map((x) => [x.file, x.line]),
    [
      ['server/exec/hints.test.ts', 10],
      ['server/exec/hints.test.ts', 11],
      ['server/gone.test.ts', 1],
    ],
  )
  assert.deepEqual(diffCases(''), { added: [], removed: [] })
  // 未跟踪的新测试文件整份算新增；不是测试文件的不算
  assert.equal(newCasesInSource('server/new.test.ts', "test('a', () => {})\nconst x = 1\nit('b', () => {})").length, 2)
  assert.equal(newCasesInSource('server/helper.ts', "test('a', () => {})").length, 0)
})

test('工作区有测试改动时本次就是工作区；只看测试目录，CI 留在仓库根的生成物不算', () => {
  assert.equal(pendingTestChanges({ tracked: '', untracked: [] }), false)
  assert.equal(pendingTestChanges({ tracked: ' M scripts/lib/test-budget.mjs\n', untracked: [] }), true)
  assert.equal(pendingTestChanges({ tracked: '', untracked: ['server/exec/new.test.ts'] }), true)
  assert.equal(pendingTestChanges({ tracked: '', untracked: ['unit-tap.txt', 'node_modules/.cache/x.json'] }), false)
})

test('出包报数：和上次发版逐项对比，缺的项按 0 算', () => {
  const after = Object.fromEntries(BUDGET_ITEMS.map((i, n) => [i.key, 10 + n]))
  const rows = countDelta({ [BUDGET_ITEMS[0].key]: 12 }, after)
  assert.equal(rows.length, BUDGET_ITEMS.length)
  assert.deepEqual(rows[0], {
    key: BUDGET_ITEMS[0].key,
    label: BUDGET_ITEMS[0].label,
    before: 12,
    after: 10,
    delta: -2,
  })
  assert.equal(rows[1].before, 0)
  assert.equal(rows[1].delta, 11)
})
