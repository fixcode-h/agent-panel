/**
 * 模型的上下文窗口、最大输出：自动识别和传给 CLI。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLimits, fmtTokens, knownLimits, limitEnvVars, limitSupport, parseTokens } from '../shared/model-limits.ts'
import { getCli } from '../shared/clis.ts'

test('内置表按模型名识别，provider 前缀不影响，不认识的留空', () => {
  assert.deepEqual(knownLimits('claude-opus-5-5'), { context: 1_000_000, maxOutput: 128_000 })
  assert.deepEqual(knownLimits('anthropic/claude-haiku-4-5'), { context: 200_000, maxOutput: 64_000 })
  assert.deepEqual(knownLimits('gemini-2.5-pro'), { context: 1_048_576, maxOutput: 65_536 })
  assert.deepEqual(knownLimits('some-new-model'), {})
  assert.deepEqual(knownLimits(''), {})
})

test('CLI 报告的数值优先于内置表', () => {
  const catalog = [{ id: 'anthropic/claude-sonnet-4-6', contextWindow: 200_000, maxOutput: 32_000 }]
  assert.deepEqual(autoLimits('claude-sonnet-4-6', catalog), { context: 200_000, maxOutput: 32_000 })
  assert.deepEqual(autoLimits('claude-opus-5-5', catalog), { context: 1_000_000, maxOutput: 128_000 })
})

test('输入「1M」「200k」「128000」都认', () => {
  assert.equal(parseTokens('1M'), 1_000_000)
  assert.equal(parseTokens(' 200k '), 200_000)
  assert.equal(parseTokens('128,000'), 128_000)
  assert.equal(parseTokens('abc'), undefined)
  assert.equal(parseTokens('0'), undefined)
  assert.equal(fmtTokens(1_000_000), '1M')
  assert.equal(fmtTokens(128_000), '128K')
  assert.equal(fmtTokens(1_048_576), '1M')
  assert.equal(fmtTokens(12_345), '12345')
})

test('Claude Code 用环境变量，Codex 只接受上下文窗口（参数），Gemini 都不接受', () => {
  const claude = getCli('claude')!
  assert.deepEqual(limitSupport(claude), { context: true, maxOutput: true })
  assert.deepEqual(limitEnvVars(claude, { context: 500_000, maxOutput: 0 }), [
    { key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', value: '500000' },
  ])
  const codex = getCli('codex')!
  assert.deepEqual(limitSupport(codex), { context: true, maxOutput: false })
  const args = codex.buildArgs({ model: 'gpt-6-sol', permission: '', extraArgs: [], contextWindow: 300_000 })
  assert.ok(args.includes('model_context_window=300000'))
  assert.ok(!codex.buildArgs({ model: 'x', permission: '', extraArgs: [] }).some((a) => a.includes('context_window')))
  assert.deepEqual(limitSupport(getCli('gemini')), { context: false, maxOutput: false })
})
