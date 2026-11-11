/** 跨项目批量同步：整文件（替换、新建、一样的跳过）和整列（按主键改右边已有的行），先预览再写 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TablesConfig, emptySchema } from '../../shared/tables.ts'
import { syncTables } from './sync.ts'

function project(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-sync-'))
  mkdirSync(path.join(dir, 'Config'))
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(dir, f), v)
  return dir
}
const cfg = TablesConfig.parse({ dirs: ['Config'] })
const side = (dir: string, id: string) => ({ projectId: id, dir, cfg, schema: emptySchema() })

test('整文件同步：预览不写，确认后替换、新建，一样的跳过', async () => {
  const l = project({ 'Config/A.csv': 'ID,HP\r\n1,10\r\n', 'Config/B.csv': 'ID\r\n1\r\n', 'Config/C.csv': 'x\r\n' })
  const r = project({ 'Config/A.csv': 'ID,HP\r\n1,9\r\n', 'Config/C.csv': 'x\r\n' })
  const items = ['Config/A.csv', 'Config/B.csv', 'Config/C.csv'].map((p) => ({ path: p }))
  const pre = await syncTables(side(l, 'l'), side(r, 'r'), { items, mode: 'file', apply: false })
  assert.deepEqual(
    pre.map((x) => [x.action, x.cells]),
    [
      ['replace', 1],
      ['create', 0],
      ['same', 0],
    ],
  )
  assert.equal(existsSync(path.join(r, 'Config/B.csv')), false)
  await syncTables(side(l, 'l'), side(r, 'r'), { items, mode: 'file', apply: true })
  assert.equal(readFileSync(path.join(r, 'Config/A.csv'), 'utf8'), 'ID,HP\r\n1,10\r\n')
  assert.equal(readFileSync(path.join(r, 'Config/B.csv'), 'utf8'), 'ID\r\n1\r\n')
  await assert.rejects(
    syncTables(
      side(l, 'l'),
      { ...side(r, 'r'), cfg: { ...cfg, readOnly: true } },
      { items, mode: 'file', apply: true },
    ),
    /只读|read-only/,
  )
})

test('整列同步：按主键只改这一列，右边没有的行不加', async () => {
  const head = 'ID,Name,HP\r\nint,string,int\r\n编号,名字,血量\r\n'
  const l = project({ 'Config/A.csv': `${head}1,甲,10\r\n2,乙,25\r\n3,丙,30\r\n` })
  const r = project({ 'Config/A.csv': `${head}2,B,20\r\n1,A,10\r\n` })
  const items = [{ path: 'Config/A.csv' }]
  const pre = await syncTables(side(l, 'l'), side(r, 'r'), { items, mode: 'column', field: 'HP', apply: false })
  assert.deepEqual(pre[0], { path: 'Config/A.csv', action: 'cells', cells: 1, missing: 1 })
  await syncTables(side(l, 'l'), side(r, 'r'), { items, mode: 'column', field: 'HP', apply: true })
  assert.equal(readFileSync(path.join(r, 'Config/A.csv'), 'utf8'), `${head}2,B,25\r\n1,A,10\r\n`)
  const bad = await syncTables(side(l, 'l'), side(r, 'r'), { items, mode: 'column', field: 'MP', apply: false })
  assert.equal(bad[0].action, 'skip')
  assert.ok(bad[0].error)
})
