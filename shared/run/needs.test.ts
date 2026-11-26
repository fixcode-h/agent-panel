import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskRun } from '../schema.ts'
import { applyNeeds, needsPart, needsSummary, needState } from './needs.ts'

const run = () => TaskRun.parse({ id: 1, status: 'running' })

test('需求对照：新拆条目自动编号，之后按编号标落地 / 延期，整批有错整批不写', () => {
  const rec = run()
  const r = applyNeeds(rec, '设计', [{ text: '黑屏结束时抛事件' }, { text: '碰杯后重开' }])
  assert.ok(r.ok, r.info)
  assert.deepEqual(
    rec.needs.map((n) => n.id),
    ['N1', 'N2'],
  )
  // 延期不写理由、编号拼错：整批拒绝，N1 也不会被标上
  assert.match(
    applyNeeds(rec, '实现', [
      { id: 'N1', state: 'done' },
      { id: 'N2', state: 'deferred' },
    ]).info,
    /理由/,
  )
  assert.match(applyNeeds(rec, '实现', [{ id: 'N9', state: 'done' }]).info, /没有 N9.*N1、N2/)
  assert.equal(needState(rec.needs[0]), 'open')
  const ok = applyNeeds(rec, '实现', [{ id: 'N1', state: 'done', note: 'Cheers.lua:42' }])
  assert.match(ok.info, /还没落地 N2/)
  assert.deepEqual(rec.needs[0].marks.at(-1)?.by, '实现')
  // 后来的节点接着编号
  applyNeeds(rec, '评审', [{ text: '重开后计分清零', state: 'dropped', note: '用户说先不做' }])
  assert.equal(rec.needs[2].id, 'N3')
  assert.deepEqual(needsSummary(rec.needs), { total: 3, open: 1, done: 1, deferred: 0, dropped: 1 })
})

test('需求对照进提示词：有条目且运行还在跑才带，列出状态和最近一次标记', () => {
  const rec = run()
  assert.equal(needsPart(rec), '')
  applyNeeds(rec, '设计', [{ text: '黑屏结束时抛事件' }])
  applyNeeds(rec, '实现', [{ id: 'N1', state: 'done', note: 'Cheers.lua:42' }])
  assert.match(needsPart(rec), /N1 \[已落地\] 黑屏结束时抛事件（实现：Cheers.lua:42）/)
  rec.status = 'done'
  assert.equal(needsPart(rec), '')
})
