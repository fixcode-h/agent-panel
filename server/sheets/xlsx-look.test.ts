/** xlsx 格子以外的显示信息：合并单元格、批注、超链接、整行底色、隐藏的工作表 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readXlsx } from '../xlsx.ts'
import { cellAt, fillStyles, readNotes } from './xlsx-look.ts'

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

const THEME =
  '<a:theme><a:themeElements><a:clrScheme name="x">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '</a:clrScheme></a:themeElements></a:theme>'

const STYLES =
  '<styleSheet><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill></fills>' +
  '<cellXfs><xf fillId="0"/><xf fillId="2"/><xf fillId="3"/><xf fillId="4"/></cellXfs></styleSheet>'

const BOOK: Record<string, string> = {
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="旧表" sheetId="2" state="hidden" r:id="rId2"/>' +
    '<sheet name="内部" sheetId="3" state="veryHidden" r:id="rId3"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Type="x/theme" Target="theme/theme1.xml"/></Relationships>',
  'xl/styles.xml': STYLES,
  'xl/theme/theme1.xml': THEME,
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>' +
    '<row r="2"><c r="A2" s="1"><v>1</v></c><c r="B2" s="1"><v>2</v></c><c r="C2" s="1"/></row>' +
    '<row r="3"><c r="A3" s="1"><v>1</v></c><c r="B3" s="2"><v>2</v></c><c r="C3"><v>3</v></c></row>' +
    '<row r="4" s="2" customFormat="1"><c r="A4"><v>4</v></c></row>' +
    '<row r="5"><c r="A5" s="3"><v>5</v></c><c r="B5" s="3"><v>5</v></c></row>' +
    '</sheetData><mergeCells count="2"><mergeCell ref="A1:C1"/><mergeCell ref="D2"/></mergeCells>' +
    '<hyperlinks><hyperlink ref="A2" r:id="rId1" tooltip="打开文档"/><hyperlink ref="B2" location="旧表!A1"/>' +
    '<hyperlink ref="C2" r:id="rId2"/></hyperlinks></worksheet>',
  'xl/worksheets/_rels/sheet1.xml.rels':
    '<Relationships><Relationship Id="rId1" Type="x/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/>' +
    '<Relationship Id="rId2" Type="x/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>',
  'xl/comments1.xml':
    '<comments><authors><author>策划甲</author></authors><commentList>' +
    '<comment ref="B3" authorId="0"><text><r><t>策划甲:</t></r><r><t xml:space="preserve">\n掉落权重，0 表示不掉</t></r></text></comment>' +
    '</commentList></comments>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet3.xml': '<worksheet><sheetData/></worksheet>',
}

test('cellAt：A1 写法换成行列，带 $ 的也认', () => {
  assert.deepEqual(cellAt('A1'), { r: 0, c: 0 })
  assert.deepEqual(cellAt('$AB$12'), { r: 11, c: 27 })
  assert.equal(cellAt('名字'), undefined)
})

test('fillStyles：实心底色按 rgb、主题色加淡化算出来，白底和花纹不算', () => {
  const s = fillStyles(STYLES, THEME)
  assert.deepEqual(s, [undefined, '#ffff00', '#a2b8e2', undefined])
})

test('readXlsx：合并单元格、批注、超链接、整行底色、隐藏的工作表', () => {
  const sheets = readXlsx(zip(BOOK))
  assert.deepEqual(
    sheets.map((s) => [s.name, !!s.hidden]),
    [
      ['数据', false],
      ['旧表', true],
      ['内部', true],
    ],
  )
  const look = sheets[0].look!
  // 只有一格的「合并」不算
  assert.deepEqual(look.merges, [{ r: 0, c: 0, rows: 1, cols: 3 }])
  // javascript: 的链接不画
  assert.deepEqual(look.links, [
    { r: 1, c: 0, url: 'https://example.com/a?b=1&c=2', tip: '打开文档' },
    { r: 1, c: 1, loc: '旧表!A1' },
  ])
  // 正文开头的「作者:」去掉
  assert.deepEqual(look.notes, [{ r: 2, c: 1, text: '掉落权重，0 表示不掉', author: '策划甲' }])
  // 第 2 行三格全黄；第 3 行黄蓝各一格、一格没样式，不过半；第 4 行整行设了样式；第 5 行白底不算
  assert.deepEqual(look.fills, [
    { r: 1, color: '#ffff00' },
    { r: 3, color: '#a2b8e2' },
  ])
  assert.equal(sheets[1].look, undefined)
})

test('readNotes：带命名空间前缀的批注文件也认', () => {
  const notes = readNotes(
    '<x:comments><x:commentList><x:comment ref="A1"><x:text><x:t>说明</x:t></x:text></x:comment></x:commentList></x:comments>',
  )
  assert.deepEqual(notes, [{ r: 0, c: 0, text: '说明' }])
})
