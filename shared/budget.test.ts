/**
 * 父对话的用量上限：整棵对话树合起来算，两项取更高的比例。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetLevel, budgetNote, budgetUse } from './budget.ts'
import { setLang } from './i18n.ts'

setLang('zh')
const tk = (id: string, parentTaskId: string, inputTokens: number, outputTokens: number, costUsd = 0) => ({
  id,
  parentTaskId,
  usage: { inputTokens, outputTokens, costUsd },
})

test('用量按整棵对话树（多层子对话）合起来算，别的对话不算进来', () => {
  const tasks = [
    tk('root', '', 100, 10, 0.5),
    tk('kid', 'root', 200, 20, 1),
    tk('grand', 'kid', 300, 30, 1.5),
    tk('other', '', 9999, 9999, 9),
  ]
  assert.deepEqual(budgetUse('root', tasks), { tokens: 660, costUsd: 3 })
  assert.deepEqual(budgetUse('kid', tasks), { tokens: 550, costUsd: 2.5 })
})

test('级别：没设是 none，过 80% 提醒，到上限 over；两项取更高的那个', () => {
  const use = { tokens: 800_000, costUsd: 1 }
  assert.equal(budgetLevel(use, undefined), 'none')
  assert.equal(budgetLevel(use, { tokens: 0, costUsd: 0 }), 'none')
  assert.equal(budgetLevel(use, { tokens: 2_000_000, costUsd: 0 }), 'ok')
  assert.equal(budgetLevel(use, { tokens: 1_000_000, costUsd: 0 }), 'warn')
  // token 只用了 40%，费用到了上限：按费用算
  assert.equal(budgetLevel(use, { tokens: 2_000_000, costUsd: 1 }), 'over')
  assert.match(budgetNote('warn', use, { tokens: 1_000_000, costUsd: 0 }), /80%（800k \/ 1\.0M token）/)
  assert.match(budgetNote('over', use, { tokens: 0, costUsd: 1 }), /\$1\.00 \/ \$1\.00/)
})
