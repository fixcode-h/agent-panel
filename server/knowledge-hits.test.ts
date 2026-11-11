/**
 * 经验、教训的命中记录落盘：并发记几次不丢、删掉的条目不显示、路径没了标过期。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的：命中记录真的写文件，不能碰本机数据
const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-hits-'))
process.env.AGENT_PANEL_DATA = dataDir

const { knowledgeHitsView, readKnowledgeHits, recordKnowledgeHits } = await import('./knowledge-hits.ts')

test('同时记几次命中不互相覆盖', async () => {
  await Promise.all([
    recordKnowledgeHits('p1', 'experience', ['a'], 't1'),
    recordKnowledgeHits('p1', 'experience', ['a', 'b'], 't2'),
    recordKnowledgeHits('p1', 'lessons', ['l1'], 't1'),
  ])
  const h = await readKnowledgeHits('p1')
  assert.equal(h.experience.a.count, 2)
  assert.equal(h.experience.b.count, 1)
  assert.deepEqual(h.lessons.l1.taskIds, ['t1'])
})

test('设置页的视图：只留还在的条目，路径没了的标出来，命令类不核对', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-hits-root-'))
  mkdirSync(path.join(root, 'src'))
  await recordKnowledgeHits('p2', 'experience', ['gone', 'kept'], 't')
  const v = await knowledgeHitsView(
    'p2',
    root,
    [
      { id: 'kept', paths: ['src/**', 'old/**'], kind: 'locate' },
      { id: 'cmd', paths: ['npm test'], kind: 'command' },
    ],
    [{ id: 'l', paths: ['nope/x.ts'] }],
  )
  assert.deepEqual(Object.keys(v.experience), ['kept'])
  assert.deepEqual(v.stale.experience, { kept: ['old/**'] })
  assert.deepEqual(v.stale.lessons, { l: ['nope/x.ts'] })
})
