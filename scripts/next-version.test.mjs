// scripts/next-version.mjs 的测试：同一主、次版本下的正式版标签逐个 +1，预览版和别的版本不算
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextVersion } from './next-version.mjs'

test('没发过这个主、次版本时从 0 开始，旧的提交数标签不影响', () => {
  assert.equal(nextVersion('0.29.0', ['v0.28.2782', 'v0.28.2780']), '0.29.0')
  assert.equal(nextVersion('0.29.0', []), '0.29.0')
})

test('上一个正式版的修订号 + 1，按数字比较不按字符串', () => {
  assert.equal(nextVersion('0.29.0', ['v0.29.0', 'v0.29.1', 'v0.29.9', 'v0.29.10']), '0.29.11')
})

test('带后缀的预览版标签和其他主、次版本不算', () => {
  assert.equal(nextVersion('0.29.0', ['v0.29.3', 'v0.29.7-dev', 'v0.30.1', 'v1.29.5', 'v0.290.1']), '0.29.4')
})

test('package.json 的版本格式不对时直接失败', () => {
  assert.throws(() => nextVersion('abc', []), /格式/)
})
