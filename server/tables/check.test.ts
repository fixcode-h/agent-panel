/** 全项目检查：读引用的表、按工作表汇总、打不开的文件单独列出 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TableSchema } from '../../shared/tables.ts'
import { checkTables } from './check.ts'

test('按结构文件查每个表格，引用的表从磁盘读', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-check-'))
  mkdirSync(path.join(dir, 'Config'))
  writeFileSync(path.join(dir, 'Config/Role.csv'), 'uint32,bytes\nID,Name\n1001,艾琳\n')
  writeFileSync(path.join(dir, 'Config/Item.csv'), 'uint32,uint32\nID,Owner\n1,1001\n2,1002\nx,\n')
  writeFileSync(path.join(dir, 'Config/Bad.xlsx'), 'not a zip')
  const schema = TableSchema.parse({
    style: { header: { start: 0, roles: ['type', 'name'] } },
    columns: { 'Config/Item.csv#*#Owner': { ref: 'Config/Role.csv#ID' } },
  })
  const r = await checkTables(
    dir,
    [
      { path: 'Config/Bad.xlsx', kind: 'xlsx', size: 9, mtime: '' },
      { path: 'Config/Item.csv', kind: 'csv', size: 1, mtime: '' },
      { path: 'Config/Role.csv', kind: 'csv', size: 1, mtime: '' },
    ],
    schema,
  )
  assert.equal(r.files, 2)
  assert.deepEqual(
    r.failed.map((f) => f.path),
    ['Config/Bad.xlsx'],
  )
  assert.equal(r.sheets.length, 1)
  assert.equal(r.sheets[0].path, 'Config/Item.csv')
  assert.deepEqual(
    r.sheets[0].first.map((p) => `${p.r}:${p.field}`),
    ['3:Owner', '4:ID'],
  )
})
