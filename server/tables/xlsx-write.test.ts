/**
 * 原地改 xlsx：改字、改数、清空、新格子、追加行、日期；没改的 zip 条目逐字节不变、样式号留着、
 * 共享字符串只在末尾追加；公式格不让改；有公式 / 合并单元格的表不让在中间插删行，没有的照常挪行号。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readXlsx } from '../xlsx.ts'
import { gridDiff, setCells, applyRowOps, type SheetEdit } from '../../shared/table-edit.ts'
import { entryText, readZip } from './zip.ts'
import { editXlsx } from './xlsx-write.ts'
import { gameBook } from './xlsx-fixture.ts'

const raw = (buf: Buffer, name: string) => {
  const z = readZip(buf)
  const e = z.entries.find((x) => x.name === name)!
  return z.buf.subarray(e.offset, e.offset + e.span)
}

function roundtrip(buf: Buffer, edits: SheetEdit[]) {
  const before = readXlsx(buf)
  const out = editXlsx(buf, edits)
  const after = readXlsx(out)
  for (const e of edits) {
    const want = setCells(applyRowOps(before.find((s) => s.name === e.name)!.rows, e.rows), e.cells)
    assert.equal(gridDiff(after.find((s) => s.name === e.name)!.rows, want), null)
  }
  return out
}

test('改字、改数、清空、补新格子、追加行：读回来和预期一样，样式号留着', () => {
  const buf = gameBook()
  const out = roundtrip(buf, [
    {
      name: '道具',
      rows: [],
      cells: [
        { r: 3, c: 1, v: '新木剑' },
        { r: 4, c: 0, v: '20' },
        { r: 3, c: 2, v: '' },
        { r: 4, c: 2, v: 'Axe' },
        { r: 5, c: 3, v: '2026-01-02' },
        { r: 6, c: 0, v: '4' },
        { r: 6, c: 1, v: '金剑' },
      ],
    },
  ])
  const xml = entryText(readZip(out), 'xl/worksheets/sheet1.xml')!
  // 原来带样式的格子清空后留着样式；新格子用上一行同列的样式
  assert.match(xml, /<c r="C4" s="3"\/>/)
  assert.match(xml, /<c r="A5" s="3"><v>20<\/v><\/c>/)
  assert.match(xml, /<row r="7"><c r="A7" s="3"><v>4<\/v><\/c><c r="B7" s="3" t="s"><v>\d+<\/v><\/c><\/row>/)
  assert.match(xml, /<dimension ref="A1:D7"\/>/)
  // 表头冻结、列宽这些不在单元格区里的部分一个字不动
  assert.ok(xml.includes('<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>'))
  assert.ok(xml.includes('<cols><col min="1" max="1" width="12" customWidth="1"/></cols>'))
  // 日期格子：页面上的日期换回序号，读回来还是日期
  assert.equal(readXlsx(out)[0].rows[5][3], '2026-01-02')
})

test('没改的条目逐字节照搬；共享字符串只在末尾追加，已有的复用', () => {
  const buf = gameBook()
  const out = editXlsx(buf, [
    {
      name: '道具',
      rows: [],
      cells: [
        { r: 3, c: 1, v: '铁剑' },
        { r: 4, c: 1, v: '银剑' },
      ],
    },
  ])
  for (const name of [
    'xl/worksheets/sheet2.xml',
    'xl/styles.xml',
    'xl/media/image1.png',
    'xl/workbook.xml',
    '[Content_Types].xml',
  ])
    assert.deepEqual(raw(out, name), raw(buf, name), name)
  const before = entryText(readZip(buf), 'xl/sharedStrings.xml')!
  const after = entryText(readZip(out), 'xl/sharedStrings.xml')!
  assert.ok(
    after.startsWith(
      before
        .slice(0, before.indexOf('<si>'))
        .replace('uniqueCount="10"', 'uniqueCount="11"')
        .replace('count="20"', 'count="22"'),
    ),
  )
  assert.ok(after.endsWith('<si><t>银剑</t></si></sst>'))
  assert.equal((after.match(/<si>/g) ?? []).length, 11)
  // 文件名、条目顺序不变
  assert.deepEqual(
    readZip(out).entries.map((e) => e.name),
    readZip(buf).entries.map((e) => e.name),
  )
})

test('公式格不让改；有公式的表改了值，打开时让 Excel 重算', () => {
  assert.throws(() => editXlsx(gameBook(), [{ name: '统计', rows: [], cells: [{ r: 0, c: 1, v: '3' }] }]), /公式格/)
  const out = roundtrip(gameBook(), [{ name: '统计', rows: [], cells: [{ r: 0, c: 0, v: '11' }] }])
  assert.match(entryText(readZip(out), 'xl/workbook.xml')!, /<calcPr fullCalcOnLoad="1" calcId="191029"\/>/)
})

test('中间插删行：没有公式等引用的表照常挪行号；有公式、合并单元格的拒绝；末尾追加总可以', () => {
  const out = roundtrip(gameBook(), [{ name: '道具', rows: [{ at: 4, n: 1 }], cells: [{ r: 4, c: 0, v: '9' }] }])
  const xml = entryText(readZip(out), 'xl/worksheets/sheet1.xml')!
  assert.match(xml, /<row r="6" spans="1:4"><c r="A6" s="3"><v>2<\/v><\/c><c r="B6"/)
  roundtrip(gameBook(), [{ name: '道具', rows: [{ at: 3, n: -1 }], cells: [] }])
  assert.throws(
    () => editXlsx(gameBook({ formulaSheet1: true }), [{ name: '道具', rows: [{ at: 3, n: 1 }], cells: [] }]),
    /公式/,
  )
  assert.throws(
    () => editXlsx(gameBook({ merge: true }), [{ name: '道具', rows: [{ at: 3, n: -1 }], cells: [] }]),
    /合并单元格/,
  )
  roundtrip(gameBook({ formulaSheet1: true }), [
    { name: '道具', rows: [{ at: 6, n: 2 }], cells: [{ r: 7, c: 0, v: '5' }] },
  ])
})

test('特殊字符：XML 实体、换行、开头空格、像转义的 _x0041_ 都原样读回', () => {
  roundtrip(gameBook(), [
    {
      name: '道具',
      rows: [],
      cells: [
        { r: 3, c: 1, v: 'a<b>&"c"' },
        { r: 4, c: 1, v: ' 两行\n文字 ' },
        { r: 5, c: 1, v: 'x_x0041_y' },
      ],
    },
  ])
})

test('长数字和带前导 0 的数字按文字存，读回来不变', () => {
  roundtrip(gameBook(), [
    {
      name: '道具',
      rows: [],
      cells: [
        { r: 3, c: 0, v: '12345678901234567' },
        { r: 4, c: 0, v: '007' },
      ],
    },
  ])
})
