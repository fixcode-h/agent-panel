/**
 * 字号角色（index.css @theme 的 --text-*）和 cn() 的合并：tailwind-merge 不认识的 text-caption 会被当成文字颜色，
 * 和后面的 text-subtle 合并时字号被丢掉（运行区的状态标签一度变回正文大小）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TEXT_ROLES, cn } from '@/lib/utils'

test('cn 合并时字号角色和文字颜色各留各的，两个字号角色只留后一个', () => {
  assert.equal(cn('px-1.5 text-caption text-success'), 'px-1.5 text-caption text-success')
  assert.equal(cn('text-footnote text-muted', 'text-subtle'), 'text-footnote text-subtle')
  assert.equal(cn('text-caption', 'text-body'), 'text-body')
})

test('cn 登记的字号角色和 index.css 里定义的一致', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  const defined = [...css.matchAll(/^\s*--text-([a-z]+):/gm)].map((m) => m[1])
  assert.deepEqual([...TEXT_ROLES].sort(), [...new Set(defined)].sort())
})
