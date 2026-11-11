/**
 * 保存表格页的改动：xlsx 原地改并备份、CSV 保持分隔符 / 换行 / BOM、
 * 文件正被 Excel 打开、打开后被外面改过、只读项目、只读文件（P4 先签出）都按预期处理。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-tables-data-'))
process.env.AGENT_PANEL_DATA = dataDir

const { TablesConfig } = await import('../../shared/tables.ts')
const { saveTable } = await import('./write.ts')
const { openTable } = await import('./files.ts')
const { gameBook } = await import('./xlsx-fixture.ts')

const cfg = (p: Partial<import('../../shared/tables.ts').TablesConfig> = {}) =>
  TablesConfig.parse({ dirs: ['Config'], ...p })

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-tables-save-'))
  mkdirSync(path.join(dir, 'Config'))
  writeFileSync(path.join(dir, 'Config', 'Item.xlsx'), gameBook())
  writeFileSync(path.join(dir, 'Config', 'Shop.csv'), '﻿ID,Name\r\n1,"a,b"\r\n2,x\r\n')
  return dir
}

test('xlsx：改完重新打开就是新内容，原文件备份到数据目录', async () => {
  const dir = project()
  const doc = await openTable(dir, 'Config/Item.xlsx', cfg())
  const next = await saveTable(dir, 'p1', cfg(), {
    path: 'Config/Item.xlsx',
    mtime: doc.mtime,
    sheets: [
      {
        name: '道具',
        rows: [{ at: 6, n: 1 }],
        cells: [
          { r: 3, c: 1, v: '新木剑' },
          { r: 6, c: 0, v: '4' },
        ],
      },
    ],
  })
  assert.equal(next.sheets[0].rows[3][1], '新木剑')
  assert.equal(next.sheets[0].rows[6][0], '4')
  assert.deepEqual(next.sheets[1], doc.sheets[1])
  const backups = readdirSync(path.join(dataDir, 'tables-backup', 'p1', 'Config'))
  assert.equal(backups.length, 1)
  assert.deepEqual(readFileSync(path.join(dataDir, 'tables-backup', 'p1', 'Config', backups[0])), gameBook())
  // 同目录没有留下临时文件
  assert.deepEqual(readdirSync(path.join(dir, 'Config')).sort(), ['Item.xlsx', 'Shop.csv'])
})

test('CSV：分隔符、换行、BOM、引号照原样，只有改了的格子变', async () => {
  const dir = project()
  const doc = await openTable(dir, 'Config/Shop.csv', cfg())
  await saveTable(dir, 'p1', cfg(), {
    path: 'Config/Shop.csv',
    mtime: doc.mtime,
    sheets: [
      {
        name: 'Shop',
        rows: [],
        cells: [
          { r: 2, c: 1, v: 'y' },
          { r: 3, c: 0, v: '3' },
          { r: 3, c: 1, v: 'z' },
        ],
      },
    ],
  })
  assert.equal(readFileSync(path.join(dir, 'Config', 'Shop.csv'), 'utf8'), '﻿ID,Name\r\n1,"a,b"\r\n2,y\r\n3,z\r\n')
})

test('拦下：项目只读、文件正被 Excel 打开、打开后外面改过（force 只放过纯改格子）', async () => {
  const dir = project()
  const doc = await openTable(dir, 'Config/Shop.csv', cfg())
  const body = {
    path: 'Config/Shop.csv',
    mtime: doc.mtime,
    sheets: [{ name: 'Shop', rows: [], cells: [{ r: 1, c: 0, v: '9' }] }],
  }
  await assert.rejects(saveTable(dir, 'p1', cfg({ readOnly: true }), body), /只读/)
  writeFileSync(path.join(dir, 'Config', '~$Shop.csv'), '')
  await assert.rejects(saveTable(dir, 'p1', cfg(), body), /Excel \/ WPS/)
  rmSync(path.join(dir, 'Config', '~$Shop.csv'))
  const later = new Date(Date.now() + 5000)
  utimesSync(path.join(dir, 'Config', 'Shop.csv'), later, later)
  await assert.rejects(saveTable(dir, 'p1', cfg(), body), /被改过/)
  await assert.rejects(
    saveTable(dir, 'p1', cfg(), {
      ...body,
      force: true,
      sheets: [{ name: 'Shop', rows: [{ at: 1, n: 1 }], cells: [] }],
    }),
    /被改过/,
  )
  const forced = await saveTable(dir, 'p1', cfg(), { ...body, force: true })
  assert.equal(forced.sheets[0].rows[1][0], '9')
})

// Windows 的只读属性和 root 用户（无视只读位）测不出来
const noReadOnly = process.platform === 'win32' || process.getuid?.() === 0
test('只读文件：P4 项目先 p4 edit 再写；不是 P4 的报没有权限', { skip: noReadOnly }, async () => {
  const dir = project()
  const file = path.join(dir, 'Config', 'Shop.csv')
  chmodSync(file, 0o444)
  const doc = await openTable(dir, 'Config/Shop.csv', cfg())
  const body = {
    path: 'Config/Shop.csv',
    mtime: doc.mtime,
    sheets: [{ name: 'Shop', rows: [], cells: [{ r: 1, c: 0, v: '9' }] }],
  }
  await assert.rejects(saveTable(dir, 'p1', cfg(), body), /只读/)
  const edited: string[] = []
  await saveTable(dir, 'p1', cfg(), body, {
    p4Edit: async (full) => {
      edited.push(full)
      chmodSync(full, 0o644)
      return { ok: true, err: '' }
    },
  })
  assert.deepEqual(edited, [file])
  assert.ok(statSync(file).mode & 0o200)
})
