/**
 * 插件包的校验和（插件框架改进 D1）：和发布时的 sha256 对不上就不装，旧 Release 没有校验文件时不校验。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifySha } from './github.ts'

const zip = Buffer.from('插件包内容')
const sha = createHash('sha256').update(zip).digest('hex')

test('校验和对得上：放行', () => {
  assert.doesNotThrow(() => verifySha(zip, sha, 'ue-1.0.0.zip'))
})

test('没有校验文件（旧 Release）：不校验', () => {
  assert.doesNotThrow(() => verifySha(zip, '', 'ue-1.0.0.zip'))
})

test('校验和对不上：拒绝安装，写明包名和两边的值', () => {
  assert.throws(() => verifySha(Buffer.from('被换过的包'), sha, 'ue-1.0.0.zip'), /ue-1\.0\.0\.zip.*校验和对不上/)
})
