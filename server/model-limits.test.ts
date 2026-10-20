/**
 * 模型的上下文窗口、最大输出和思考强度：模型目录匹配、自动识别和传给 CLI。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLimits, fmtTokens, knownLimits, limitEnvVars, limitSupport, parseTokens } from '../shared/model-limits.ts'
import { DEFAULT_MODEL_CONTEXT, DEFAULT_MODEL_MAX_OUTPUT, matchModel } from '../shared/model-catalog.ts'
import { getCli } from '../shared/clis.ts'
import { supportsEffort } from '../shared/settings.ts'

test('模型目录按厂商和类型识别，provider 前缀不影响', () => {
  const opus = knownLimits('claude-opus-5-5')
  assert.equal(opus.context, 1_000_000)
  assert.equal(opus.maxOutput, 128_000)
  assert.equal(opus.tier, 'high')
  assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(opus.defaultEffort, 'high')
  assert.equal(knownLimits('anthropic/claude-haiku-5-5').tier, 'low')
  assert.equal(knownLimits('gemini-3-pro').context, 1_048_576)
  // deepseek-flash 和带协议后缀的 BYOK 写法都用同一份目录：low / high / max
  assert.deepEqual(knownLimits('deepseek/deepseek-v4-flash').efforts, ['low', 'high', 'max'])
  assert.equal(knownLimits('deepseek/deepseek-v4-flash').defaultEffort, 'high')
  assert.deepEqual(knownLimits('tokenapi/deepseek/deepseek-v4-flash-anthropic').efforts, ['low', 'high', 'max'])
  assert.deepEqual(knownLimits('some-new-model'), {})
  assert.deepEqual(knownLimits(''), {})
})

test('Command Code 的思考强度跟着模型走，不用全局列表', () => {
  const cc = getCli('commandcode')!
  assert.equal(cc.effortsFromModel, true)
  assert.equal(cc.modelBoundSession, true)
  assert.deepEqual(cc.efforts, [])
  // 交给执行前按模型判断，这里先放行
  assert.equal(supportsEffort('commandcode', 'xhigh'), true)
})

test('模型名带协议、速度后缀：类型优先于版本', () => {
  // 目录里只有 deepseek-flash（没版本）和 deepseek-v4-pro
  assert.equal(matchModel('tokenapi/deepseek/deepseek-v4-flash')?.entry.id, 'deepseek-flash')
  assert.equal(matchModel('deepseek/deepseek-v4-flash-responses')?.entry.id, 'deepseek-flash')
  assert.equal(matchModel('deepseek-v4-flash-fast')?.entry.id, 'deepseek-flash')
  assert.equal(matchModel('deepseek-v4-flash:free')?.entry.id, 'deepseek-flash')
  assert.equal(matchModel('deepseek-v4-pro')?.entry.id, 'deepseek-v4-pro')
  assert.equal(matchModel('openai/gpt-6-sol-2026-01-15')?.entry.id, 'gpt-6-sol')
})

test('模型名带协议后缀时按协议优先', () => {
  assert.equal(matchModel('deepseek-v4-flash-responses', { protocol: 'openai-responses' })?.entry.id, 'deepseek-flash')
  assert.equal(matchModel('gpt-6.1-sol-responses', { protocol: 'openai-chat' })?.entry.id, 'gpt-6.1-sol')
})

test('厂商初筛不拿别家凑数；opus / sonnet 这类别名按类型匹配', () => {
  assert.equal(matchModel('somevendor/some-new-model'), undefined)
  assert.equal(matchModel('opus')?.entry.id, 'claude-opus-5-5')
  assert.equal(matchModel('sonnet')?.entry.id, 'claude-sonnet-5-5')
})

test('太老的模型不套新模型的数值', () => {
  assert.equal(matchModel('claude-haiku-3-5'), undefined)
  assert.equal(matchModel('claude-haiku-4-5'), undefined)
  assert.equal(matchModel('claude-haiku-6')?.entry.id, 'claude-haiku-5-5')
})

test('目录里没有的模型按 1M / 128K 估算', () => {
  const auto = autoLimits('some-new-model')
  assert.equal(auto.context, DEFAULT_MODEL_CONTEXT)
  assert.equal(auto.maxOutput, DEFAULT_MODEL_MAX_OUTPUT)
  assert.equal(auto.matched, false)
  assert.equal(auto.source, 'default')
})

test('CLI 报告的数值优先于模型目录', () => {
  const catalog = [{ id: 'anthropic/claude-sonnet-4-6', contextWindow: 200_000, maxOutput: 32_000 }]
  const auto = autoLimits('claude-sonnet-4-6', catalog)
  assert.equal(auto.context, 200_000)
  assert.equal(auto.maxOutput, 32_000)
  assert.equal(auto.source, 'cli')
  assert.equal(auto.matched, true)
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
