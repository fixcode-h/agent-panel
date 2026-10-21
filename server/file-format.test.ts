import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_FILE_FORMAT, Settings } from '../shared/schema.ts'
import { encodeText, projectFormat } from '../shared/file-format.ts'

/**
 * 文件格式：默认 UTF-8 无 BOM + LF；项目设置优先，没设时跟随全局。
 * 这是 Windows 上编辑、WSL 里跑脚本不再报 bad interpreter 的基础。
 */

test('默认是 UTF-8 无 BOM、LF：shebang 在 Linux 里能直接执行', () => {
  const bytes = encodeText('#!/usr/bin/env node\nconsole.log(1)\n', DEFAULT_FILE_FORMAT)
  assert.equal(bytes[0], 0x23, '第一个字节就是 #，没有 BOM')
  assert.ok(!(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))), '不能有 UTF-8 BOM')
  assert.ok(!bytes.includes(0x0d), '不能有 CR')
})

test('选 CRLF 时换行写成 \\r\\n，CR 不会重复叠加', () => {
  const bytes = encodeText('a\r\nb\nc', { encoding: 'utf8', eol: 'crlf' })
  assert.equal(bytes.toString('utf8'), 'a\r\nb\r\nc')
})

test('选带 BOM 时开头是 EF BB BF，读完去掉不影响内容', () => {
  const bytes = encodeText('x\ny\n', { encoding: 'utf8-bom', eol: 'lf' })
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(bytes.subarray(3).toString('utf8'), 'x\ny\n')
})

test('项目设置优先，没设时跟随全局设置', () => {
  const global = Settings.parse({ fileFormat: { encoding: 'utf8-bom', eol: 'crlf' } })
  assert.deepEqual(projectFormat(undefined, global), { encoding: 'utf8-bom', eol: 'crlf' })
  assert.deepEqual(projectFormat({}, global), { encoding: 'utf8-bom', eol: 'crlf' })
  assert.deepEqual(projectFormat({ fileFormat: { encoding: 'utf8', eol: 'lf' } }, global), {
    encoding: 'utf8',
    eol: 'lf',
  })
})

test('没配置时全局设置就是 UTF-8 无 BOM + LF', () => {
  assert.deepEqual(Settings.parse({}).fileFormat, DEFAULT_FILE_FORMAT)
})

test('旧的设置文件里没有 fileFormat 也能读出来，非法值回到默认', () => {
  assert.deepEqual(Settings.parse({ stepTimeoutMinutes: 5 }).fileFormat, DEFAULT_FILE_FORMAT)
  assert.deepEqual(Settings.parse({ fileFormat: { encoding: 'gbk', eol: 'cr' } }).fileFormat, DEFAULT_FILE_FORMAT)
})
