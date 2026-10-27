/**
 * 对话里报错的分类：常见的 CLI 报错归到对的一类，每一类都有说明。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertInfo, classifyError, makeAlert } from './alerts.ts'
import { setLang } from './i18n.ts'
import { AlertKind } from './schema.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

test('常见报错归到对的一类', () => {
  const cases: [string, string][] = [
    ['Error: Unable to connect to the API. Please check your network connection.', 'network'],
    ['Stream connection failed mid-response: terminated', 'network'],
    ['read ECONNRESET', 'network'],
    ['429 Too Many Requests', 'rate_limit'],
    ['{"type":"overloaded_error","message":"Overloaded"}', 'rate_limit'],
    ['Invalid API key · Please run /login', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['Insufficient balance', 'quota'],
    ['prompt is too long: 210000 tokens > 200000 maximum', 'context'],
    ['400 invalid_request_error: model `foo` does not exist', 'model'],
    ['spawn cmdc ENOENT', 'cli_missing'],
    ['Command Code 没有完成这一轮就退出了', 'cli_exit'],
  ]
  for (const [text, kind] of cases) assert.equal(classifyError(text), kind, text)
})

test('每一类都有标题、说明和处理办法', () => {
  for (const kind of AlertKind.options) {
    const info = alertInfo(kind)
    assert.ok(info.title && info.what && info.fix, kind)
  }
})

test('上游网关断开单列一类：502、Connection closed、响应没传完', () => {
  const cases = [
    '502 Bad Gateway',
    '503 Service Unavailable',
    'upstream connect error or disconnect/reset before headers',
    '500: {"message":"litellm.APIConnectionError: APIConnectionError: DeepseekException - Connection closed.","type":null,"param":null,"code":"500"}',
    'Response payload is not completed',
  ]
  for (const text of cases) assert.equal(classifyError(text), 'gateway', text)
})

test('重试提示按原因给出不同的下一步', () => {
  const gateway = alertInfo('retry', '502 Bad Gateway')
  const limit = alertInfo('retry', '429 Too Many Requests')
  const context = alertInfo('retry', 'prompt is too long: 210000 tokens > 200000 maximum')
  // 行上还是「正在重试」：状态不变，原因和下一步在展开里区分
  for (const info of [gateway, limit, context]) assert.equal(info.title, '正在重试')
  assert.match(gateway.what, /网关|中转/)
  assert.match(gateway.fix, /换一个接口|换模型|减少/)
  assert.match(limit.what, /限流|过载/)
  assert.match(limit.fix, /自动重试/)
  assert.match(context.what, /上下文/)
  assert.match(context.fix, /自动压缩/)
  // 分类只看关键字，分不出「上游不稳」和「请求接近上限被断开」：不能写成确定性否定，
  // 否则用户会跳过真正有效的动作（看上下文占用、压缩）
  assert.doesNotMatch(gateway.what, /不属于上下文超长|不是你的网络/)
  assert.match(gateway.fix, /自动压缩/)
  // 三种原因各说各的，不能是同一段话
  assert.equal(new Set([gateway.fix, limit.fix, context.fix]).size, 3)
})

test('网关断开的说明保留「可能是上下文接近上限」这条线索', () => {
  const info = alertInfo('gateway')
  assert.equal(info.title, '上游连接断开')
  assert.doesNotMatch(info.what, /不属于上下文超长|不是你的网络/)
  assert.match(info.fix, /自动压缩/)
  assert.match(info.fix, /代理|中转/)
})

test('重试的原因看不出时给通用说明', () => {
  const info = alertInfo('retry', 'agent exited with code 1')
  assert.equal(info.title, '正在重试')
  assert.match(info.fix, /原始信息/)
})

test('指定了分类就不再按正文猜', () => {
  assert.deepEqual(makeAlert('warn', 'ECONNRESET', 'no_response'), {
    kind: 'no_response',
    level: 'warn',
    detail: 'ECONNRESET',
  })
  assert.equal(makeAlert('error', 'ECONNRESET').kind, 'network')
})
