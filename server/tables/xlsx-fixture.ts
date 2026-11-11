/**
 * 测试用的 xlsx：照 Excel / WPS 存出来的样子拼（共享字符串、样式号、spans、公式、日期样式、
 * 第二张表、一张图片、带数据描述符的条目），用来验证原地改写只动该动的地方。只给测试用。
 */
import { deflateRawSync } from 'node:zlib'
import { crc32 } from './zip.ts'

interface Part {
  name: string
  data: Buffer
  /** 不压缩直接存 */
  stored?: boolean
  /** 用数据描述符（大小和校验写在数据后面，WPS 存出来的有这种） */
  descriptor?: boolean
}

export function buildZip(parts: Part[]) {
  const out: Buffer[] = []
  const dir: Buffer[] = []
  let offset = 0
  for (const p of parts) {
    const data = p.stored ? p.data : deflateRawSync(p.data)
    const crc = crc32(p.data)
    const name = Buffer.from(p.name, 'utf8')
    const flags = p.descriptor ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(p.stored ? 0 : 8, 8)
    local.writeUInt16LE(0x6000, 10)
    local.writeUInt16LE(0x5a6b, 12)
    if (!p.descriptor) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(p.data.length, 22)
    }
    local.writeUInt16LE(name.length, 26)
    const desc = Buffer.alloc(p.descriptor ? 16 : 0)
    if (p.descriptor) {
      desc.writeUInt32LE(0x08074b50, 0)
      desc.writeUInt32LE(crc, 4)
      desc.writeUInt32LE(data.length, 8)
      desc.writeUInt32LE(p.data.length, 12)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(p.stored ? 0 : 8, 10)
    central.writeUInt16LE(0x6000, 12)
    central.writeUInt16LE(0x5a6b, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(p.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    out.push(local, name, data, desc)
    dir.push(central, name)
    offset += 30 + name.length + data.length + desc.length
  }
  const cd = Buffer.concat(dir)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...out, cd, end])
}

const x = (s: string) => Buffer.from(s, 'utf8')

/** 一张游戏配置表（表头 3 行 + 数据 3 行）+ 一张带公式的统计表 + 一张图片 */
export function gameBook(opts: { formulaSheet1?: boolean; merge?: boolean } = {}) {
  const sst = ['optional', 'uint32', 'string', 'ID', 'Name', 'Kind', '木剑', '铁剑', 'Sword', 'Date']
  /** 共享字符串的序号就是它在 sst 里的位置 */
  const s = (i: number) => i
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:D6"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="12" customWidth="1"/></cols><sheetData><row r="1" spans="1:4"><c r="A1" s="1" t="s"><v>${s(0)}</v></c><c r="B1" s="1" t="s"><v>${s(0)}</v></c><c r="C1" s="1" t="s"><v>${s(0)}</v></c><c r="D1" s="1" t="s"><v>${s(0)}</v></c></row><row r="2" spans="1:4"><c r="A2" s="1" t="s"><v>${s(1)}</v></c><c r="B2" s="1" t="s"><v>${s(2)}</v></c><c r="C2" s="1" t="s"><v>${s(2)}</v></c><c r="D2" s="1" t="s"><v>${s(9)}</v></c></row><row r="3" spans="1:4"><c r="A3" s="2" t="s"><v>${s(3)}</v></c><c r="B3" s="2" t="s"><v>${s(4)}</v></c><c r="C3" s="2" t="s"><v>${s(5)}</v></c><c r="D3" s="2" t="s"><v>${s(9)}</v></c></row><row r="4" spans="1:4"><c r="A4" s="3"><v>1</v></c><c r="B4" s="3" t="s"><v>${s(6)}</v></c><c r="C4" s="3" t="s"><v>${s(8)}</v></c><c r="D4" s="4"><v>46023</v></c></row><row r="5" spans="1:4"><c r="A5" s="3"><v>2</v></c><c r="B5" s="3" t="s"><v>${s(7)}</v></c><c r="C5" s="3"/><c r="D5" s="4"><v>46024.5</v></c></row><row r="6" spans="1:4"><c r="A6" s="3"><v>3</v></c><c r="B6" s="3" t="s"><v>${s(6)}</v></c>${opts.formulaSheet1 ? '<c r="C6" s="3"><f>A6*2</f><v>6</v></c>' : ''}</row></sheetData>${opts.merge ? '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' : ''}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c></row><row r="2"><c r="A2"><v>5</v></c></row></sheetData></worksheet>`
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="20" uniqueCount="${sst.length}">${sst.map((v) => `<si><t>${v}</t></si>`).join('')}</sst>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy/m/d h:mm"/></numFmts><fonts count="1"><font><sz val="11"/></font></fonts><cellXfs count="5"><xf numFmtId="0" fontId="0"/><xf numFmtId="0" fontId="0" fillId="2"/><xf numFmtId="0" fontId="0" fillId="3"/><xf numFmtId="0" fontId="0"/><xf numFmtId="176" fontId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`
  const book = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="道具" sheetId="1" r:id="rId1"/><sheet name="统计" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029"/></workbook>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  return buildZip([
    { name: '[Content_Types].xml', data: x('<Types/>') },
    { name: 'xl/workbook.xml', data: x(book) },
    { name: 'xl/_rels/workbook.xml.rels', data: x(rels) },
    { name: 'xl/worksheets/sheet1.xml', data: x(sheet1), descriptor: true },
    { name: 'xl/worksheets/sheet2.xml', data: x(sheet2) },
    { name: 'xl/sharedStrings.xml', data: x(sstXml) },
    { name: 'xl/styles.xml', data: x(styles) },
    { name: 'xl/media/image1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), stored: true },
  ])
}
