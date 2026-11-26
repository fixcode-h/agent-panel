/** 学到的经验里的路径：绝对路径直接看、相对路径按项目根和文档根找。运行：npm run test:unit */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { shapeLearned } from './learn.ts'

test('文档根在项目外：绝对路径和文档根下的相对路径都认得，真不存在的才丢', async () => {
  const proj = mkdtempSync(path.join(tmpdir(), 'ap-learn-proj-'))
  const doc = mkdtempSync(path.join(tmpdir(), 'ap-learn-doc-'))
  mkdirSync(path.join(doc, 'adr'))
  mkdirSync(path.join(proj, 'Source'))
  const item = {
    op: 'add' as const,
    id: '',
    kind: 'locate' as const,
    title: '规范文档在哪',
    body: 'ADR 在文档根的 adr/，代码在 Source/',
    keywords: ['ADR'],
    paths: [path.join(doc, 'adr'), 'adr/', 'Source/**', 'NoSuch/'],
  }
  const r = await shapeLearned(item, [proj, doc], { branch: '', taskId: 't' })
  assert.deepEqual(r.item?.paths, [path.join(doc, 'adr'), 'adr/', 'Source/**'])
})
