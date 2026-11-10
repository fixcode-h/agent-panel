/**
 * 「我不在」模式的判定：只认问题上的 reversible、recommended 字段，拿不准的一律不选。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import { addPick, askMeta, AWAY_PICKS_MAX, awayAnswers, AwayState, dropPicks, switchAway } from './away.ts'
import { AskQuestion } from './task-request.ts'

setLang('zh')

const q = (over: Record<string, unknown> = {}) =>
  AskQuestion.parse({
    question: '配置放哪？',
    options: [{ label: 'settings.ts（推荐）' }, { label: '新文件' }],
    ...over,
  })

test('标了能反悔、写了推荐项的单选题：按推荐项选', () => {
  assert.deepEqual(awayAnswers({ kind: 'question', questions: [q({ reversible: true, recommended: 1 })] }), ['新文件'])
})

test('拿不准的一律不选：缺字段、不可反悔、多选、序号越界、有一个问题不行整个不选', () => {
  const none = (questions: AskQuestion[]) => awayAnswers({ kind: 'question', questions })
  // label 里写了「（推荐）」也不算：不按文字猜
  assert.equal(none([q()]), undefined)
  assert.equal(none([q({ recommended: 0 })]), undefined)
  assert.equal(none([q({ reversible: true })]), undefined)
  assert.equal(none([q({ reversible: false, recommended: 0 })]), undefined)
  assert.equal(none([q({ reversible: true, recommended: 0, multiSelect: true })]), undefined)
  assert.equal(none([q({ reversible: true, recommended: 2 })]), undefined)
  assert.equal(none([q({ reversible: true, recommended: 0 }), q()]), undefined)
  assert.equal(none([]), undefined)
})

test('只管提问：审批、确认、面板自己的授权都不选', () => {
  const questions = [q({ reversible: true, recommended: 0 })]
  for (const kind of ['command', 'file', 'tool', 'confirm'] as const)
    assert.equal(awayAnswers({ kind, questions }), undefined)
  assert.equal(awayAnswers({ kind: 'question', purpose: 'push', questions }), undefined)
})

test('模型交来的字段类型不对就当没写', () => {
  assert.deepEqual(askMeta({ recommended: 1, reversible: true }), { recommended: 1, reversible: true })
  assert.deepEqual(askMeta({ recommended: '1', reversible: 'yes' }), {})
  assert.deepEqual(askMeta({ recommended: -1 }), {})
  assert.deepEqual(askMeta({ recommended: 0.5 }), {})
  assert.deepEqual(askMeta(undefined), {})
})

test('开关和记录：打开记下时间、再开不改；关掉清时间不清记录；记录有上限、新的在前', () => {
  let s = switchAway(AwayState.parse({}), true, '2026-11-10T08:00:00.000Z')
  assert.equal(s.since, '2026-11-10T08:00:00.000Z')
  s = switchAway(s, true, '2026-11-10T09:00:00.000Z')
  assert.equal(s.since, '2026-11-10T08:00:00.000Z')
  const pick = (id: string) => ({ id, taskId: 't', projectId: 'p', taskTitle: '', items: [], at: '' })
  for (let i = 0; i < AWAY_PICKS_MAX + 5; i++) s = addPick(s, pick(`p${i}`))
  assert.equal(s.picks.length, AWAY_PICKS_MAX)
  assert.equal(s.picks[0].id, `p${AWAY_PICKS_MAX + 4}`)
  s = switchAway(s, false)
  assert.equal(s.on, false)
  assert.equal(s.since, '')
  assert.equal(s.picks.length, AWAY_PICKS_MAX)
  assert.equal(dropPicks(s, s.picks[0].id).picks.length, AWAY_PICKS_MAX - 1)
  assert.equal(dropPicks(s).picks.length, 0)
})
