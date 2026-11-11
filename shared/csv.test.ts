/** CSV 的读写：写回时保持原来的分隔符、换行、BOM、结尾换行，要加引号的格子才加 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { csvFormat, parseCsv, writeCsv } from './csv.ts'

test('读出写法再原样写回，内容一个字节不差', () => {
  for (const text of [
    '\ufeffID,Name\r\n1,"a,b"\r\n2,"say ""hi"""\r\n',
    'ID;Name\n1;x\n2;"多\n行"',
    'ID\tName\n1\tx\n',
  ]) {
    const f = csvFormat(text, text.includes('\t'))
    assert.equal(writeCsv(parseCsv(text, f.delimiter), f), text)
  }
})

test('只给要加引号的格子加引号', () => {
  const out = writeCsv([['a', 'b,c', 'd"e', ' f', '']], { delimiter: ',', eol: 'lf', bom: false })
  assert.equal(out, 'a,"b,c","d""e", f,\n')
})
