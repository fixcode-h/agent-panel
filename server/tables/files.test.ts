/** 表格页的文件层：按表格目录列文件（包含 / 排除、跳过的目录、找不到的目录）、打开、只读原因、内容搜索、路径越界 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TableSchema, TablesConfig } from '../../shared/tables.ts'
import { listTables, lockedByOffice, openTable, safeRel, searchTables } from './files.ts'

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-tables-'))
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  put('Config/Item.csv', '\ufeffID,Name\r\n1,木剑\r\n2,铁剑\r\n')
  put('Config/sub/Skill.tsv', 'ID\tName\n10\t火球\n')
  put('Config/old.xls', 'binary')
  put('Config/~$Item.xlsx', 'lock')
  put('Config/node_modules/x.csv', 'a,b\n')
  put('Config/readme.md', '# not a table')
  put('Other/Out.csv', 'a,b\n')
  return dir
}

const cfg = (p: Partial<TablesConfig> = {}) => TablesConfig.parse({ dirs: ['Config', 'Missing'], ...p })

test('列出表格目录里的表格：按包含 / 排除筛，跳过锁文件和 node_modules，记下找不到的目录', async () => {
  const dir = project()
  const r = await listTables(dir, cfg())
  assert.deepEqual(
    r.files.map((f) => `${f.path}:${f.kind}`),
    ['Config/Item.csv:csv', 'Config/old.xls:xls', 'Config/sub/Skill.tsv:csv'],
  )
  assert.deepEqual(r.dirs, ['Config'])
  assert.deepEqual(r.missing, ['Missing'])
  const only = await listTables(dir, cfg({ include: '*.tsv' }))
  assert.deepEqual(
    only.files.map((f) => f.path),
    ['Config/sub/Skill.tsv'],
  )
})

test('打开 CSV：记下分隔符、换行、BOM，保存时照原样写回；老 xls 只给只读原因', async () => {
  const dir = project()
  const doc = await openTable(dir, 'Config/Item.csv', cfg())
  assert.deepEqual(doc.sheets[0].rows, [
    ['ID', 'Name'],
    ['1', '木剑'],
    ['2', '铁剑'],
  ])
  assert.equal(doc.csv?.delimiter, ',')
  assert.equal(doc.csv?.eol, 'crlf')
  assert.equal(doc.csv?.bom, true)
  assert.equal(doc.readOnly, undefined)
  assert.equal(doc.locked, false)
  const tsv = await openTable(dir, 'Config/sub/Skill.tsv', cfg())
  assert.equal(tsv.csv?.delimiter, '\t')
  const xls = await openTable(dir, 'Config/old.xls', cfg())
  assert.equal(xls.sheets.length, 0)
  assert.ok(xls.readOnly)
  const ro = await openTable(dir, 'Config/Item.csv', cfg({ readOnly: true }))
  assert.ok(ro.readOnly)
})

test('路径不能跑出项目目录', async () => {
  const dir = project()
  assert.throws(() => safeRel(dir, '../x.csv'))
  assert.throws(() => safeRel(dir, '/etc/passwd'))
  assert.throws(() => safeRel(dir, 'C:/x.csv'))
  assert.equal(safeRel(dir, './Config\\Item.csv').rel, 'Config/Item.csv')
  await assert.rejects(openTable(dir, 'Config/../../x.csv', cfg()))
})

test('Excel / WPS 的锁文件说明文件正被打开', async () => {
  const dir = project()
  writeFileSync(path.join(dir, 'Config', '~$Item.csv'), '')
  assert.equal(await lockedByOffice(path.join(dir, 'Config', 'Item.csv')), true)
  assert.equal(await lockedByOffice(path.join(dir, 'Config', 'sub', 'Skill.tsv')), false)
})

test('内容搜索：不分大小写，跨文件给出工作表、行列和那格的字', async () => {
  const dir = project()
  const { files } = await listTables(dir, cfg())
  const r = await searchTables(dir, files, '剑')
  assert.deepEqual(
    r.hits.map((h) => `${h.path}#${h.sheet}!${h.row},${h.col}=${h.text}`),
    ['Config/Item.csv#Item!1,1=木剑', 'Config/Item.csv#Item!2,1=铁剑'],
  )
  assert.equal(r.files, 2)
  assert.deepEqual((await searchTables(dir, files, '  ')).hits, [])
  // 给了结构文件：数据行的命中带上字段名（按表头的字段名行），表头里的命中不带
  const schema = TableSchema.parse({ style: { header: { start: 0, roles: ['name'] } } })
  const named = await searchTables(dir, files, 'name', undefined, schema)
  assert.equal(named.hits[0].field, undefined)
  assert.deepEqual(
    (await searchTables(dir, files, '剑', undefined, schema)).hits.map((h) => h.field),
    ['Name', 'Name'],
  )
})

test('表格目录可以是绝对路径：项目目录里的换成相对路径，项目目录外的按绝对路径列，多层子目录都找', async () => {
  const dir = project()
  const outside = mkdtempSync(path.join(tmpdir(), 'agent-panel-designer-'))
  mkdirSync(path.join(outside, 'Excel', 'A', 'B'), { recursive: true })
  writeFileSync(path.join(outside, 'Excel', 'A', 'B', 'Deep.csv'), 'ID\n1\n')
  const r = await listTables(
    dir,
    TablesConfig.parse({ dirs: [path.join(dir, 'Config'), path.join(outside, 'Excel'), 'Nope'] }),
  )
  const abs = `${path.join(outside, 'Excel').replace(/\\/g, '/')}`
  assert.deepEqual(r.dirs, ['Config', abs])
  assert.ok(r.files.some((f) => f.path === `${abs}/A/B/Deep.csv`))
  assert.deepEqual(
    r.roots?.map((x) => [x.found, x.files]),
    [
      [true, 3],
      [true, 1],
      [false, 0],
    ],
  )
  assert.equal(r.roots?.[2].full, path.join(dir, 'Nope'))
  // 项目目录外的文件：只有落在设置的表格目录里才能打开
  const c = TablesConfig.parse({ dirs: [path.join(outside, 'Excel')] })
  const doc = await openTable(dir, `${abs}/A/B/Deep.csv`, c)
  assert.deepEqual(doc.sheets[0].rows, [['ID'], ['1']])
  assert.throws(() => safeRel(dir, path.join(outside, 'x.csv'), c))
  assert.throws(() => safeRel(dir, `${abs}/A/B/Deep.csv`))
})
