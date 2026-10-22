/**
 * 「能不能开始用」的检查：哪些条件必须满足、哪些只提示；
 * 以及角色没指定 CLI 时用哪个（设置里的默认）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CliStatus } from '@shared/schema'
import { cliFor, isReady, type Check } from '@/lib/readiness'

const check = (ok: boolean, optional = false): Check => ({ ok, label: '', hint: '', optional })
const cli = (id: string, isDefault = false) => ({ id, isDefault, name: id }) as CliStatus

test('isReady：可选项没满足也算就绪，必选项没满足就不算', () => {
  assert.equal(isReady([check(true), check(false, true)]), true)
  assert.equal(isReady([check(true), check(false)]), false)
  assert.equal(isReady([]), true)
})

test('cliFor：角色指定了 CLI 就用它，指定的是停用的也照原样返回', () => {
  const clis = [cli('claude', true), cli('codex')]
  assert.equal(cliFor({ cli: 'codex' }, clis)?.id, 'codex')
  assert.equal(cliFor({ cli: 'gemini' }, clis), undefined)
})

test('cliFor：没指定时用设置里的默认，没有默认就用第一个', () => {
  assert.equal(cliFor({ cli: '' }, [cli('codex'), cli('claude', true)])?.id, 'claude')
  assert.equal(cliFor({ cli: '' }, [cli('codex'), cli('claude')])?.id, 'codex')
  assert.equal(cliFor({ cli: '' }, []), undefined)
})
