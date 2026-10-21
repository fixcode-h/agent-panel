/**
 * CLI 报错的说明：常见的报错换成能照着做的话。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { TaskMessage } from '../../shared/schema.ts'
import { describeCompaction, failureHints, settleNetNotes } from './runner.ts'

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

test('Command Code 的响应流中途断开：按断流处理，给出续接说明', () => {
  const hints = failureHints('Failed to process successful response', { id: 'commandcode', name: 'Command Code' })
  assert.equal(hints.length, 1)
  assert.match(hints[0], /连接中途断开/)
})

test('自动续接成功后，断开时的报错不再显示成错误', () => {
  const msg: TaskMessage = {
    id: 'n1',
    role: 'system',
    agentId: '',
    step: '',
    text: 'Command Code 执行失败：\n原始输出：\nFailed to process successful response\n\n正在自动续接会话重试（第 1/2 次）…',
    tools: [],
    at: '',
    error: true,
  }
  settleNetNotes([{ msg, base: 'Command Code 执行失败：\n原始输出：\nFailed to process successful response', n: 1 }])
  assert.equal(msg.error, undefined, '这一轮最终成功了，不能一直挂着红色错误')
  assert.equal(msg.transient, true, '继续执行时要能去掉')
  assert.match(msg.text, /Failed to process successful response/, '断开的原因留着，方便查')
  assert.match(msg.text, /已自动续接会话（第 1 次）/)
  assert.doesNotMatch(msg.text, /正在自动续接/)
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
