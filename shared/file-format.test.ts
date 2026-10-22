import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeText, projectFormat } from './file-format.ts'
import { DEFAULT_FILE_FORMAT, Settings } from './schema.ts'

test('默认写出来是 UTF-8 无 BOM、LF，混着的换行统一成 LF', () => {
  const buf = encodeText('a\r\nb\rc\n', DEFAULT_FILE_FORMAT)
  assert.equal(buf.toString('utf8'), 'a\nb\nc\n')
  assert.notEqual(buf[0], 0xef, '不能带 UTF-8 BOM')
})

test('选了 CRLF / BOM 时按格式写：BOM 只在开头，换行全部是 CRLF', () => {
  const buf = encodeText('a\nb\r\nc', { encoding: 'utf8-bom', eol: 'crlf' })
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(buf.subarray(3).toString('utf8'), 'a\r\nb\r\nc')
})

test('项目的格式优先于全局设置，都没设时用默认格式', () => {
  const settings = Settings.parse({ fileFormat: { encoding: 'utf8-bom', eol: 'crlf' } })
  assert.deepEqual(projectFormat(undefined, settings), { encoding: 'utf8-bom', eol: 'crlf' })
  assert.deepEqual(projectFormat({ fileFormat: { encoding: 'utf8', eol: 'lf' } }, settings), {
    encoding: 'utf8',
    eol: 'lf',
  })
  assert.deepEqual(projectFormat(undefined, Settings.parse({})), DEFAULT_FILE_FORMAT)
})
