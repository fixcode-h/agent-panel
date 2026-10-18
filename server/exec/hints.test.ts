/**
 * CLI 报错的说明：常见的报错换成能照着做的话。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import { failureHints } from './runner.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const gemini = { id: 'gemini', name: 'Gemini CLI' }

test('Google 不再支持个人账号用 Gemini CLI：说明是服务端限制，指到 API 方式', () => {
  const detail =
    'An unexpected critical error occurred:IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.'
  const hints = failureHints(detail, gemini)
  assert.equal(hints.length, 1)
  assert.match(hints[0], /Google 服务端的限制/)
  assert.match(hints[0], /API 配置/)
})

test('普通的报错不加说明', () => {
  assert.deepEqual(failureHints('something else went wrong', gemini), [])
})

test('Pi 没配 API Key：提示在终端里登录', () => {
  const hints = failureHints('No API key found for anthropic.\n\nUse /login to log into a provider', {
    id: 'pi',
    name: 'Pi',
  })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /运行 pi，在里面输入 \/login/)
})
