/**
 * CLI 报错的说明：常见的报错换成能照着做的话。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import { describeCompaction, failureHints } from './runner.ts'

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

test('模型接口拒绝聊天记录：说明换模型后旧会话接不上', () => {
  const detail =
    'litellm.BadRequestError: OpenAIException - {"error":{"type":"invalid_request_error","code":"400002","message":"The request parameter input.content is invalid or missing.","param":"input.content"}}'
  const hints = failureHints(detail, { id: 'codex', name: 'Codex' })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /input\.content/)
  assert.match(hints[0], /新建一个对话/)
})

test('压缩上下文：写明压缩了多少、现在占上下文窗口多少', () => {
  const tool = { kind: 'compact' as const, label: '', detail: '' }
  describeCompaction(tool, 96_000, 14_000, 200_000)
  assert.equal(tool.label, '压缩了 82.0k token（96.0k → 14.0k）')
  assert.equal(tool.detail, '当前占用 7%')
  describeCompaction(tool, 9000)
  assert.equal(tool.label, '压缩前 9.0k token')
  assert.equal(tool.detail, '')
})
