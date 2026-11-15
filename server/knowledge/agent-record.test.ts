/**
 * 第 8 条（2026-11-15 用户定）：Agent 新记的教训只在记下它的那个对话里立即生效，对别的对话是候选；
 * 带 id 改写自己记的那条改候选本身，改写已在项目教训里的仍走项目教训的写入口。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-agent-record-'))

const { lessonFromAgent, withConvLessons } = await import('./agent-record.ts')
const { readKnowledgeState, updateKnowledgeState } = await import('./store.ts')
const { addEpisode } = await import('../../shared/knowledge/capture.ts')
const { errorPrint } = await import('../../shared/knowledge/match/fingerprint.ts')
const { ProjectLesson } = await import('../../shared/schema.ts')

const ERR = 'src/a.ts(1,1): error TS2589: Type instantiation is excessively deep and possibly infinite.'

test('新记的教训进候选：记下它的对话里生效，别的对话看不到；不写项目教训', async () => {
  const drafts: unknown[] = []
  const record = async (d: unknown) => (drafts.push(d), { ok: true, info: '写了项目教训' })
  const r = await lessonFromAgent(
    'p1',
    { title: '改表格先读表头', rule: '先 `table_schema`', cause: '', paths: ['tables/**'] },
    [],
    record,
    'convA',
  )
  assert.equal(r.ok, true)
  assert.match(r.info, /这个对话.*立即生效/)
  assert.equal(drafts.length, 0, '不直接写进项目教训')
  const mine = await withConvLessons('p1', [], 'convA')
  assert.deepEqual(
    mine.map((l) => [l.title, l.source, l.enabled]),
    [['改表格先读表头', 'agent', true]],
  )
  assert.deepEqual(await withConvLessons('p1', [], 'convB'), [])
  // 已经在项目教训里的同名条目以项目教训为准，不重复
  const proj = ProjectLesson.parse({ id: 'L1', title: '改表格先读表头' })
  assert.deepEqual(
    (await withConvLessons('p1', [proj], 'convA')).map((l) => l.id),
    ['L1'],
  )
  const cand = (await readKnowledgeState('p1')).candidates[0]
  assert.equal(cand.origin, 'agent')

  // 带 id 改写自己记的那条：改候选，id 不变
  const r2 = await lessonFromAgent(
    'p1',
    { title: '改表格先读表头和类型行', rule: 'r', cause: '', paths: [], replaces: cand.id, why: '用户补充' },
    [],
    record,
    'convA',
  )
  assert.match(r2.info, /已改写/)
  const after = (await readKnowledgeState('p1')).candidates
  assert.equal(after.length, 1)
  assert.equal(after[0].id, cand.id)
  assert.equal(after[0].title, '改表格先读表头和类型行')
  assert.equal(drafts.length, 0)

  // 别的对话拿这个 id 改写：不是它的候选，交给项目教训的写入口（那边会说找不到）
  await lessonFromAgent(
    'p1',
    { title: 'x', rule: '', cause: '', paths: [], replaces: cand.id, why: 'w' },
    [],
    record,
    'convB',
  )
  assert.equal(drafts.length, 1)
})

test('带 episode 记的：当场记录换成对话的候选；同一个坑在别的对话再出现时按 Agent 写的规则转正', async () => {
  const now = new Date().toISOString()
  const ep = { failed: 'npx tsc', fixed: 'npx tsc -b', purpose: 'npx tsc', print: errorPrint(ERR) }
  const id = await updateKnowledgeState('p2', (s) => {
    const x = addEpisode(s, ep, 'convA', now)
    return { next: x.next, out: x.cand.id }
  })
  const record = async () => ({ ok: true, info: '' })
  await lessonFromAgent(
    'p2',
    { title: '类型检查用 tsc -b', rule: '用 `npx tsc -b`', cause: '', paths: [], episode: id },
    [],
    record,
    'convA',
  )
  const s = await readKnowledgeState('p2')
  assert.equal(s.candidates.length, 1)
  assert.equal(s.candidates[0].origin, 'agent')
  assert.equal(s.candidates[0].errors.length, 1, '报错指纹从当场记录里补上')
  assert.equal((await withConvLessons('p2', [], 'convA'))[0].triggers.errors.length, 1)
  const again = addEpisode(s, ep, 'convB', now)
  assert.equal(again.recurred, true)
  assert.equal(again.cand.title, '类型检查用 tsc -b')
})
