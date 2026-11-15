import assert from 'node:assert/strict'
import test from 'node:test'
import { pluginOnFor, toggleCapability } from './capabilities.ts'

test('全局生效的插件（含没写 activation 的旧插件）对所有项目和无项目的对话都生效', () => {
  assert.equal(pluginOnFor(undefined, 'video', 'global'), true)
  assert.equal(pluginOnFor(undefined, 'old', undefined), true)
  assert.equal(pluginOnFor({ capabilities: { plugins: [] } }, 'video', 'global'), true)
})

test('按项目生效的插件只在打开了的项目里生效', () => {
  assert.equal(pluginOnFor(undefined, 'ue', 'project'), false, '没有项目（Chat）不生效')
  assert.equal(pluginOnFor({}, 'ue', 'project'), false, '旧项目没有 capabilities')
  assert.equal(pluginOnFor({ capabilities: { plugins: ['tables'] } }, 'ue', 'project'), false)
  assert.equal(pluginOnFor({ capabilities: { plugins: ['ue'] } }, 'ue', 'project'), true)
})

test('开关一项能力：不重复、关掉只去掉这一项、不改原对象', () => {
  const before = { plugins: ['tables'] }
  const on = toggleCapability(before, 'plugins', 'ue', true)
  assert.deepEqual(on, { plugins: ['tables', 'ue'], mcp: [], skills: [] })
  assert.deepEqual(toggleCapability(on, 'plugins', 'ue', true).plugins, ['tables', 'ue'])
  assert.deepEqual(toggleCapability(on, 'plugins', 'tables', false).plugins, ['ue'])
  assert.deepEqual(before, { plugins: ['tables'] })
})
