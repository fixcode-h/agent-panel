import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUDGET_BASELINE,
  BUDGET_ITEMS,
  TEST_BUDGET,
  checkBudget,
  commitMessageFor,
  newCasesFromDiff,
  overBudgets,
  parseBudgetNote,
  pendingTestChanges,
} from './test-budget.mjs'
import { LAYERS } from './test-layers.mjs'

/** 各层计数都贴着上限的基准值：单项超限时只看那一项 */
const atLimit = () => Object.fromEntries(BUDGET_ITEMS.map((item) => [item.key, TEST_BUDGET[item.key]]))

test('预算：各层都没超、上限也没抬时通过', () => {
  const result = checkBudget({ counts: atLimit(), commitMessage: '内部：调了一处日志' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.raised, [])
  assert.deepEqual(result.over, [])
  assert.equal(result.ok, true, '没有超限时不需要测试预算段')
})

test('预算：超出上限且提交说明没有「测试预算:」段时失败，报出层与超出数量', () => {
  const counts = { ...atLimit(), integration: TEST_BUDGET.integration + 3 }
  const result = checkBudget({ counts, commitMessage: '修复：设置弹窗位置' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.over, [
    {
      key: 'integration',
      label: '集成层用例',
      count: TEST_BUDGET.integration + 3,
      limit: TEST_BUDGET.integration,
      excess: 3,
    },
  ])
  assert.equal(result.note, '')
})

test('预算：提交说明写了「测试预算:」段时放行，空段不算', () => {
  const counts = { ...atLimit(), pure: TEST_BUDGET.pure + 3 }
  const note = '测试预算:\n- 合并了 3 条同输入的旧用例，覆盖关系写在 docs/modules/testing/README.md'
  const ok = checkBudget({ counts, commitMessage: `改进：用例合并\n\n${note}\n\n修复：别的东西` })
  assert.equal(ok.ok, true)
  assert.equal(ok.note, note)

  const empty = checkBudget({ counts, commitMessage: '改进：用例合并\n\n测试预算:\n\n修复：别的东西' })
  assert.equal(empty.ok, false, '只写前缀的空段不能放行')
  assert.equal(empty.note, '')
})

test('预算：把上限抬到冻结基线之上时失败，写「测试预算:」段也不放行', () => {
  const budget = { ...TEST_BUDGET, e2eSteps: BUDGET_BASELINE.e2eSteps + 10 }
  const result = checkBudget({
    counts: { ...atLimit(), e2eSteps: budget.e2eSteps },
    budget,
    commitMessage: '测试预算:\n- 新增了 10 个 e2e 步骤',
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.raised, [
    { key: 'e2eSteps', label: 'e2e 步骤', limit: BUDGET_BASELINE.e2eSteps + 10, baseline: BUDGET_BASELINE.e2eSteps },
  ])
  assert.deepEqual(result.over, [], '数量没超上限，只是上限被抬了')
})

test('预算：按层判超限，不靠合计——tap 复核也用同一份按层判定', () => {
  // 两层一增一减、合计不变：只有按层判才看得出集成层超了
  const counts = {
    ...atLimit(),
    [LAYERS.integration]: TEST_BUDGET[LAYERS.integration] + 2,
    [LAYERS.pure]: TEST_BUDGET[LAYERS.pure] - 2,
  }
  assert.deepEqual(
    overBudgets({ counts }).map((o) => o.key),
    [LAYERS.integration],
  )
  assert.equal(checkBudget({ counts, commitMessage: '' }).ok, false)
})

test('预算：工作区有未提交改动时不用 HEAD 的说明，干净时才用（只看会影响用例的改动）', () => {
  const headMessage = '改进：合并用例\n\n测试预算:\n- 合并了 3 条同输入用例'
  assert.equal(commitMessageFor({ headMessage, hasUncommittedChanges: true }), '', '上一次提交的说明不能当本次的')
  assert.equal(commitMessageFor({ headMessage, hasUncommittedChanges: false }), headMessage, 'CI 里 HEAD 就是本次提交')
  assert.equal(commitMessageFor({}), '')

  // 脏判定只看测试目录：CI 里 tee 出来的 tap 报告在仓库根，不能因此把 HEAD 的提交说明丢掉
  assert.equal(pendingTestChanges({ tracked: '', untracked: [] }), false)
  assert.equal(pendingTestChanges({ tracked: ' M scripts/lib/test-budget.mjs\n', untracked: [] }), true)
  assert.equal(pendingTestChanges({ tracked: '', untracked: ['server/exec/new.test.ts'] }), true)
  assert.equal(pendingTestChanges({ tracked: '', untracked: ['unit-tap.txt', 'node_modules/.cache/x.json'] }), false)
})

test('预算：从 diff 里取新增用例的位置，按 hunk 行号递增且只算新增行', () => {
  const diff = [
    'diff --git a/server/exec/hints.test.ts b/server/exec/hints.test.ts',
    '--- a/server/exec/hints.test.ts',
    '+++ b/server/exec/hints.test.ts',
    '@@ -10,0 +11,3 @@',
    "+test('新增一', () => {})",
    '+  // 注释不算',
    "+  it('新增二', () => {})",
    'diff --git a/server/gone.test.ts b/server/gone.test.ts',
    '--- a/server/gone.test.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    "-test('删掉的', () => {})",
  ].join('\n')
  assert.deepEqual(newCasesFromDiff(diff), [
    { file: 'server/exec/hints.test.ts', line: 11, text: "test('新增一', () => {})" },
    { file: 'server/exec/hints.test.ts', line: 13, text: "it('新增二', () => {})" },
  ])
  assert.deepEqual(newCasesFromDiff(''), [])
  assert.equal(parseBudgetNote(''), '')
})
