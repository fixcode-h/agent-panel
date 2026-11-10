import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparePluginVersions, isNewerPlugin } from './version.ts'

test('插件版本按主、次、修订号比', () => {
  assert.ok(comparePluginVersions('0.2.0', '0.1.9') > 0)
  assert.ok(comparePluginVersions('v1.10.0', '1.9.0') > 0)
  assert.equal(comparePluginVersions('1.0.0', '1.0.0'), 0)
})

test('正式版比同号的预发布版新，预发布段逐段比', () => {
  assert.equal(isNewerPlugin('3.1.0', '3.1.0-alpha.1'), true)
  assert.equal(isNewerPlugin('3.1.0-alpha.2', '3.1.0-alpha.1'), true)
  assert.equal(isNewerPlugin('3.1.0-alpha.10', '3.1.0-alpha.9'), true)
  assert.equal(isNewerPlugin('3.1.0-beta', '3.1.0-alpha.5'), true)
  assert.equal(isNewerPlugin('3.1.0-alpha.1', '3.1.0-alpha'), true)
  assert.equal(isNewerPlugin('3.1.0-alpha.1', '3.1.0'), false)
})

test('装着的比市场新、认不出版本号时不提示更新', () => {
  assert.equal(isNewerPlugin('0.1.0', '0.2.0'), false)
  assert.equal(isNewerPlugin('latest', '0.1.0'), false)
})
