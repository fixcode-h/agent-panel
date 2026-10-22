import assert from 'node:assert/strict'
import test from 'node:test'
import { apiInjection, type ApiConfig, type ApiProtocol } from '../shared/accounts.ts'
import { getCli } from '../shared/clis.ts'
import { apiModelInfo, apiModelKey } from '../shared/model-catalog.ts'
import { parserFor } from './exec/parsers.ts'
import { pickPiBuiltin, type PiBuiltinModel } from './models.ts'

const api = (protocol: ApiProtocol, baseUrl: string): ApiConfig => ({
  id: 'a1',
  name: 'relay',
  provider: 'relay',
  protocol,
  baseUrl,
  apiKey: 'k',
  authHeader: 'x-api-key',
  models: ['m'],
  modelMap: {},
  modelEfforts: {},
})

/** 写进 CLI 配置的接口地址：Pi 写在 models.json 的 providers.<provider>.baseUrl，其余 CLI 看对应的键 */
const piBaseUrl = (a: ApiConfig) => {
  const edit = apiInjection(getCli('pi')!.auth!, a).edits[0]
  return (edit.set['providers.relay'] as { baseUrl: string }).baseUrl
}

test('接口地址按各 CLI 自己拼版本路径的方式写', () => {
  // Anthropic SDK 自己加 /v1/messages：带 /v1 的中转地址去掉，不然请求的是 /v1/v1/messages
  assert.equal(piBaseUrl(api('anthropic', 'https://relay.example.com/v1/')), 'https://relay.example.com')
  assert.equal(piBaseUrl(api('anthropic', 'https://api.deepseek.com/anthropic')), 'https://api.deepseek.com/anthropic')
  // Pi 的 Gemini 接口把地址当成已经带版本的
  assert.equal(
    piBaseUrl(api('gemini', 'https://generativelanguage.googleapis.com')),
    'https://generativelanguage.googleapis.com/v1beta',
  )
  assert.equal(piBaseUrl(api('gemini', 'https://g.example.com/v1beta')), 'https://g.example.com/v1beta')
  // OpenAI 兼容的地址原样用（有的不是 /v1，例如火山的 /api/v3）
  assert.equal(piBaseUrl(api('openai-responses', 'https://relay.example.com/v1')), 'https://relay.example.com/v1')
  assert.equal(
    piBaseUrl(api('openai-chat', 'https://ark.cn-beijing.volces.com/api/v3')),
    'https://ark.cn-beijing.volces.com/api/v3',
  )

  const claude = apiInjection(getCli('claude')!.auth!, api('anthropic', 'https://relay.example.com/v1')).edits[0]
  assert.equal(claude.set['env.ANTHROPIC_BASE_URL'], 'https://relay.example.com')
  const gemini = apiInjection(getCli('gemini')!.auth!, api('gemini', 'https://g.example.com/v1beta')).edits[1]
  assert.equal(gemini.set.GOOGLE_GEMINI_BASE_URL, 'https://g.example.com')
})

test('Pi 只在结束时给整段思考（有的 Responses 中转不推增量）也要显示', () => {
  const parse = parserFor('pi', process.cwd())
  const events = parse({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '先看看目录结构' },
  })
  assert.deepEqual(events, [{ type: 'thinking', text: '先看看目录结构', delta: false }])
  // 推过增量的照常拼接，结束时的整段不再发一遍（Pi 的 thinking_end 可能在工具参数之后才到）
  const delta = parse({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先' },
  })
  assert.deepEqual(delta, [{ type: 'thinking', text: '先', delta: true }])
  const end = parse({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '先' },
  })
  assert.deepEqual(end, [])
})

test('模型目录没有的模型按 Pi 自带的目录找，优先同一种接口', () => {
  const list: PiBuiltinModel[] = [
    { provider: 'azure', id: 'gpt-5.4-mini', api: 'azure-openai-responses', reasoning: true },
    {
      provider: 'openai',
      id: 'gpt-5.4-mini',
      api: 'openai-responses',
      reasoning: true,
      thinkingLevelMap: { minimal: null, xhigh: 'xhigh' },
    },
    { provider: 'openai', id: 'gpt-4.1', api: 'openai-responses', reasoning: false },
  ]
  assert.equal(pickPiBuiltin(list, 'agentpanel/gpt-5.4-mini', 'openai-responses')?.provider, 'openai')
  assert.equal(pickPiBuiltin(list, 'GPT-5.4-mini', 'openai-completions')?.provider, 'azure')
  assert.equal(pickPiBuiltin(list, 'gpt-4.1', 'openai-responses')?.reasoning, false)
  assert.equal(pickPiBuiltin(list, 'kimi-k2', 'openai-responses'), undefined)
})

test('按模型记的表：带 provider 前缀的模型也能找到 API 里写的那一项', () => {
  const table = { 'deepseek/deepseek-v4': 'x', 'custom-x': 'y' }
  assert.equal(apiModelKey('agentpanel/custom-x', table), 'custom-x')
  assert.equal(apiModelKey('agentpanel/deepseek/deepseek-v4', table), 'deepseek/deepseek-v4')
  assert.equal(apiModelKey('custom-x', table), 'custom-x')
  assert.equal(apiModelKey('other', table), 'other')
  // 映射到目录里的模型后按它的强度算
  const info = apiModelInfo('agentpanel/custom-x', {
    protocol: 'openai-responses',
    modelMap: { 'custom-x': 'gpt-6.1-sol' },
  })
  assert.equal(info.entry?.id, 'gpt-6.1-sol')
})
