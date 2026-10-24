/**
 * 对话里报错的分类：常见的 CLI 报错归到对的一类，每一类都有说明。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertInfo, classifyError, makeAlert } from './alerts.ts'
import { AlertKind } from './schema.ts'

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

test('指定了分类就不再按正文猜', () => {
  assert.deepEqual(makeAlert('warn', 'ECONNRESET', 'no_response'), {
    kind: 'no_response',
    level: 'warn',
    detail: 'ECONNRESET',
  })
  assert.equal(makeAlert('error', 'ECONNRESET').kind, 'network')
})
