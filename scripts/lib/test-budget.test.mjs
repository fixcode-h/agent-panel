import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUDGET_BASELINE,
  BUDGET_ITEMS,
  TEST_BUDGET,
  checkBudget,
  commitMessageFor,
  mergedChainMessages,
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

test('预算：合并提交的说明只有标题时，子提交里的「测试预算:」段也算本次的', () => {
  const note = '测试预算:\n- 新增 2 条集成层用例，合并了 attachments.test.ts 里同输入的 2 条'
  // 面板 / GitHub 生成的合并提交：HEAD 只有一行标题，预算段写在被合进来的子提交里
  const merged = commitMessageFor({
    headMessage: 'Agent 面板：合并「附图直接放对话目录，文件按绝对路径读」',
    mergedMessages: ['内部：改了一处日志', `改进：合并用例\n\n${note}`],
  })
  assert.equal(parseBudgetNote(merged), note)
  const counts = { ...atLimit(), integration: TEST_BUDGET.integration + 2 }
  assert.equal(checkBudget({ counts, commitMessage: merged }).ok, true, '子提交的预算段能放行')

  // 普通提交没有 mergedMessages：行为不变
  assert.equal(commitMessageFor({ headMessage: '修复：设置弹窗位置' }), '修复：设置弹窗位置')
  // HEAD 自己有预算段时用 HEAD 的，别拿子提交上一轮的说明顶替
  assert.equal(
    parseBudgetNote(
      commitMessageFor({ headMessage: `改进：合并\n\n${note}`, mergedMessages: ['测试预算:\n- 旧的替代关系'] }),
    ),
    note,
  )
  // 子提交的标题不是分类前缀时，别把它的标题和正文并进 HEAD 的预算段
  assert.equal(
    parseBudgetNote(
      commitMessageFor({
        headMessage: `改进：合并\n\n${note}`,
        mergedMessages: ['Agent 面板：合并「x」\n\n正文里也提一句测试预算的事'],
      }),
    ),
    note,
  )
  // 工作区有未提交改动时，合并进来的说明也不能当本次的
  assert.equal(commitMessageFor({ headMessage: 'x', mergedMessages: [note], hasUncommittedChanges: true }), '')
})

test('预算：合并链沿第二个父往下取说明，不横向读 base 上的段', () => {
  const note = '测试预算:\n- 合并了 3 条同输入用例'
  // GitHub PR merge → dev tip（面板的合并提交，只有标题）→ 子对话提交（段在这里）
  const commits = {
    'dev-tip': { parents: ['dev-base', 'sub'], message: 'Agent 面板：合并「附图直接放对话目录」' },
    sub: { parents: ['sub-base'], message: `改进：合并用例\n\n${note}` },
    // base 上的段不属于本次 PR：不能横向读过来放行
    'dev-base': { parents: ['older'], message: '改进：主干前进\n\n测试预算:\n- 旧的替代关系' },
  }
  const getParents = (sha) => commits[sha]?.parents ?? []
  const getMessage = (sha) => commits[sha]?.message ?? ''
  const messages = mergedChainMessages({ tip: 'dev-tip', getParents, getMessage })
  assert.deepEqual(messages, ['Agent 面板：合并「附图直接放对话目录」', `改进：合并用例\n\n${note}`])
  assert.equal(parseBudgetNote(commitMessageFor({ headMessage: 'PR 标题', mergedMessages: messages })), note)

  // tip 本身就是普通提交时只取它自己的说明
  assert.deepEqual(mergedChainMessages({ tip: 'sub', getParents, getMessage }), [`改进：合并用例\n\n${note}`])
})

test('预算：合并链不沿第二父走进 base 侧，子分支 merge 过 base 时停在子分支提交', () => {
  const oldNote = '测试预算:\n- 上一次的替代关系'
  // 子分支自己 merge 过 dev：这种合并提交的第一父是子分支、第二父是 base 方向
  const commits = {
    subMerge: { parents: ['sub-prev', 'dev-old'], message: '改进：把 dev 合进子分支' },
    'sub-prev': { parents: [], message: '改进：子分支上一个提交' },
    'dev-old': { parents: ['dev-base', 'old-sub'], message: 'Agent 面板：合并「上一次」' },
    'old-sub': { parents: ['dev-base'], message: `改进：上一次\n\n${oldNote}` },
  }
  const messages = mergedChainMessages({
    tip: 'subMerge',
    getParents: (sha) => commits[sha]?.parents ?? [],
    getMessage: (sha) => commits[sha]?.message ?? '',
    // dev-old 在 base 侧：再往下就是上一次改动，不是本次的
    isBaseSide: (sha) => sha === 'dev-old',
  })
  assert.deepEqual(messages, ['改进：把 dev 合进子分支'])
  assert.equal(parseBudgetNote(commitMessageFor({ headMessage: '合并标题', mergedMessages: messages })), '')
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
