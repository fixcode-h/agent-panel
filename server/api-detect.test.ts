import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCli } from '../shared/clis.ts'
import { ApiSource } from '../shared/accounts.ts'
import { parseDotenv, resolveValue, toApi } from './api-detect.ts'
import { parseToml } from './mcp-store.ts'

test('识别 API：Codex 的 config.toml 里自己接的提供方，密钥从 env_key 指的环境变量取', () => {
  const def = getCli('codex')!
  const src = def.auth!.apiSources[0]
  const toml = parseToml(`model = "x"
model_provider = "or"

[model_providers.or]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OR_KEY"
wire_api = "chat"
`)
  const or = (toml.model_providers as Record<string, Record<string, unknown>>).or
  const api = toApi(def, src, 'or', or, { OR_KEY: 'sk-or' })!
  assert.equal(api.name, 'Codex · OpenRouter')
  assert.equal(api.protocol, 'openai-chat')
  assert.equal(api.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(api.apiKey, 'sk-or')
  // 面板自己写进去的不算
  assert.equal(toApi(def, src, 'agentpanel', or, {}), null)
})

test('识别 API：Claude Code 的 ANTHROPIC_AUTH_TOKEN 用 Bearer，没配时不算', () => {
  const def = getCli('claude')!
  const src = def.auth!.apiSources[1]
  const api = toApi(
    def,
    src,
    '',
    { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'm1' },
    {},
  )!
  assert.equal(api.authHeader, 'bearer')
  assert.equal(api.apiKey, 'tok')
  assert.deepEqual(api.models, ['m1'])
  assert.equal(toApi(def, src, '', {}, {}), null)
})

test('识别 API：Pi 的 models.json 协议按 wire 反查，模型取 id', () => {
  const def = getCli('pi')!
  const api = toApi(
    def,
    def.auth!.apiSources[0],
    'ds',
    {
      baseUrl: 'https://api.deepseek.com',
      api: 'anthropic-messages',
      apiKey: 'DS_KEY',
      models: [{ id: 'a' }, { id: 'b' }],
    },
    { DS_KEY: 'sk-ds' },
  )!
  assert.equal(api.protocol, 'anthropic')
  assert.equal(api.apiKey, 'sk-ds')
  assert.deepEqual(api.models, ['a', 'b'])
})

test('识别 API：面板旧版本写的密钥占位名不算用户的配置', () => {
  const def = getCli('pi')!
  const src = def.auth!.apiSources[0]
  const entry = {
    baseUrl: 'https://tokenapi.happyelements.net/v1',
    api: 'openai-responses',
    apiKey: 'AGENT_PANEL_API_KEY',
    models: [{ id: 'a' }],
  }
  // 环境变量早就没有值了，配置里剩下的是面板留下的旧 provider
  assert.equal(toApi(def, src, 'codeg', entry, {}), null)
  assert.equal(toApi(def, src, 'codeg', { ...entry, apiKey: '$AGENT_PANEL_API_KEY' }, {}), null)
})

test('识别 API：值的写法和 .env', () => {
  assert.equal(resolveValue('$K', { K: 'v' }), 'v')
  assert.equal(resolveValue('${K}', { K: 'v' }), 'v')
  assert.equal(resolveValue('NOT_SET', {}), 'NOT_SET')
  assert.equal(resolveValue('!pass show x', {}), '')
  assert.deepEqual(parseDotenv('# c\nDEEPSEEK_API_KEY="abc"\nexport X=1\n'), { DEEPSEEK_API_KEY: 'abc', X: '1' })
  assert.equal(ApiSource.parse({ protocol: 'anthropic' }).format, 'json')
})
