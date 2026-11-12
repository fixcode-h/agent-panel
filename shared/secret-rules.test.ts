/**
 * 密钥规则两份要一致：shared/secret-rules.ts（面板用）和 scripts/secret-check.mjs（仓库 lint 用）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SECRET_RULES, hasSecret, isPlaceholder, secretInLine } from './secret-rules.ts'
// @ts-expect-error 仓库脚本是 .mjs，没有类型声明
import { RULES, isPlaceholder as scriptPlaceholder } from '../scripts/secret-check.mjs'

test('密钥规则：面板和 lint 脚本是同一套', () => {
  const a = SECRET_RULES.map((r) => `${r.name} ${r.re.source} ${r.re.flags}`)
  const b = (RULES as { name: string; re: RegExp }[]).map((r) => `${r.name} ${r.re.source} ${r.re.flags}`)
  assert.deepEqual(a, b)
  for (const v of ['sk-xxxx', 'your-api-key', 'abc', '<token>'])
    assert.equal(isPlaceholder(v), (scriptPlaceholder as (v: string) => boolean)(v), v)
})

test('密钥规则：真实样子的值命中，占位符、环境变量引用不算', () => {
  const fake = ['sk', 'ant', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-') // secret-check-ok 测试里拼出来的假值
  assert.equal(secretInLine(`key: ${fake}`)?.rule, 'sk- 开头的 API key')
  assert.equal(secretInLine('api_key = sk-xxxx'), undefined)
  assert.equal(secretInLine('api_key = process.env.OPENAI_API_KEY'), undefined)
  assert.equal(secretInLine('password: OPENAI_API_KEY_NAME'), undefined)
  assert.ok(hasSecret(`a\nBearer ${'Ab9'.repeat(10)}`))
})
