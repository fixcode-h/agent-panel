/** 表格结构文件：拆成 4 个文件存、读回来一样、没变的不重写、空的部分不建文件、坏文件当没有 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TableSchema } from '../../shared/tables.ts'
import { readSchema, writeSchema } from './schema-store.ts'

test('写进去再读出来一样；没变的部分不重写，空的部分不建文件', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'agent-panel-schema-')), 'tables')
  const s = TableSchema.parse({
    style: { header: { start: 0, roles: ['modifier', 'side', 'type', 'name', 'comment'] } },
    enums: { MountType: { values: [{ name: 'FloorMirror', value: '1' }] } },
    analyzedAt: '2026-11-10T00:00:00.000Z',
  })
  await writeSchema(dir, s)
  assert.deepEqual(await readSchema(dir), s)
  assert.equal(existsSync(path.join(dir, 'columns.json')), false)
  assert.match(readFileSync(path.join(dir, 'style.json'), 'utf8'), /"analyzedAt"/)
  const before = statSync(path.join(dir, 'enums.json')).mtimeMs
  await new Promise((r) => setTimeout(r, 20))
  await writeSchema(dir, { ...s, files: { 'a.xlsx#Sheet1': { start: 1, roles: ['name'] } } })
  assert.equal(statSync(path.join(dir, 'enums.json')).mtimeMs, before)
  assert.ok(existsSync(path.join(dir, 'files.json')))
})

test('手改坏的文件当没有，表格页照样能打开', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-schema-'))
  writeFileSync(path.join(dir, 'enums.json'), '{ broken')
  writeFileSync(path.join(dir, 'style.json'), JSON.stringify({ key: 'Id' }))
  const s = await readSchema(dir)
  assert.equal(s.style.key, 'Id')
  assert.deepEqual(s.enums, {})
})
