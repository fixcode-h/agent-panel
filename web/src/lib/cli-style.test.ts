/**
 * CLI 显示用的纯逻辑：版本号的取法、思考强度下拉的选项。
 * 思考强度的选项错了会让 CLI 收到它不认的强度直接退出，所以默认值、当前值那几条单独测。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CliDefinition } from '@shared/clis'
import { defaultEffortOptions, shortVersion } from '@/lib/cli-style'

const def = {
  efforts: [
    { id: 'low', label: 'low' },
    { id: 'high', label: 'high' },
    { id: 'max', label: 'max' },
  ],
} as unknown as CliDefinition

test('shortVersion：从 CLI 的版本输出里只取版本号', () => {
  assert.equal(shortVersion('codex-cli 0.46.0'), '0.46.0')
  assert.equal(shortVersion('2.1.3 (Claude Code)'), '2.1.3')
  assert.equal(shortVersion('cmdc version 0.5.0-beta.1'), '0.5.0-beta.1')
  assert.equal(shortVersion(undefined), '')
})

test('defaultEffortOptions：默认的那档值留空，表示「不指定」', () => {
  assert.deepEqual(defaultEffortOptions(def, 'high'), [
    { value: 'low', label: 'low' },
    { value: '', label: 'high' },
    { value: 'max', label: 'max' },
  ])
})

test('defaultEffortOptions：不知道默认是哪档时，最前面放「auto」', () => {
  assert.deepEqual(defaultEffortOptions(def, undefined), [
    { value: '', label: 'auto' },
    { value: 'low', label: 'low' },
    { value: 'high', label: 'high' },
    { value: 'max', label: 'max' },
  ])
  assert.equal(defaultEffortOptions(def, 'ultra')[0].label, 'ultra')
})

test('defaultEffortOptions：设置里存着、当前模型又不支持的强度也列出来，下拉里不会没有当前值', () => {
  const opts = defaultEffortOptions(def, 'high', undefined, 'ultra')
  assert.deepEqual(opts.at(-1), { value: 'ultra', label: 'ultra' })
  assert.equal(opts.length, 4)
})

test('defaultEffortOptions：当前值就是默认值时不再重复列一条', () => {
  const opts = defaultEffortOptions(def, 'high', undefined, 'high')
  assert.equal(opts.filter((o) => o.label === 'high').length, 1)
})
