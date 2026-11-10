/** 读 xlsx 给文件弹窗当表格看：共享字符串、日期、布尔、公式、稀疏的行列、命名空间前缀 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readXlsx, sheetsOf } from './xlsx.ts'

/** 拼一个最小的 zip：deflate 为 false 时不压缩直接存 */
function zip(files: Record<string, string>, deflate = true) {
  const parts: Buffer[] = []
  const dir: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflate ? deflateRawSync(raw) : raw
    const n = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    parts.push(local, n, data)
    dir.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(dir)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

const BOOK: Record<string, string> = {
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="道具 &amp; 装备" sheetId="1" r:id="rId1"/><sheet name="空表" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':
    '<sst><si><t>ID</t></si><si><r><t>铁</t></r><r><t xml:space="preserve">剑 &lt;1&gt;</t></r><rPh><t>てつ</t></rPh></si><si/></sst>',
  'xl/styles.xml':
    '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/></numFmts>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><v>1001</v></c><c r="C2" s="1"><v>46053.5</v></c><c r="D2" s="2"><v>46053</v></c><c r="E2" s="1"/></row>' +
    '<row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" t="inlineStr"><is><t>直接写的</t></is></c>' +
    '<c r="C4"><v>0.30000000000000004</v></c><c r="D4" t="str"><f>A2&amp;"x"</f><v>1001x</v></c><c r="E4"><f>SUM(A2:A3)</f></c></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
}

test('readXlsx：各种单元格都换成看得懂的文字，空行空列留着位置', () => {
  for (const deflate of [true, false]) {
    const sheets = readXlsx(zip(BOOK, deflate))
    assert.deepEqual(sheets, [
      {
        name: '道具 & 装备',
        rows: [
          ['ID', '铁剑 <1>'],
          ['1001', '', '2026-01-31 12:00:00', '2026-01-31'],
          [],
          ['TRUE', '直接写的', '0.3', '1001x', '=SUM(A2:A3)'],
        ],
      },
      { name: '空表', rows: [] },
    ])
  }
})

test('带命名空间前缀的 xlsx 也能读', () => {
  const sheets = readXlsx(
    zip({
      'xl/workbook.xml': '<x:workbook><x:sheets><x:sheet name="S" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<x:worksheet><x:sheetData><x:row><x:c t="str"><x:v>a</x:v></x:c><x:c><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    }),
  )
  assert.deepEqual(sheets, [{ name: 'S', rows: [['a', '2']] }])
})

test('sheetsOf：不是 xlsx 的扩展名、解析不了的内容都不给表格', () => {
  assert.equal(sheetsOf('a.zip', zip(BOOK)), undefined)
  assert.equal(sheetsOf('a.xlsx', Buffer.from('这不是 zip，是加密或者改了扩展名的文件')), undefined)
  assert.equal(sheetsOf('a.XLSX', zip(BOOK))?.length, 2)
})
