import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ApiConfig,
  apiEndpoint,
  apiModelsForProtocol,
  apiProtocols,
  cliApiProtocol,
  modelsForProtocols,
  withEndpoints,
} from '../accounts.ts'
import { getCli } from '../clis.ts'
import { Settings } from '../schema.ts'
import { cliSettings, modelText } from '../settings.ts'
import { shownModelName } from '../models/catalog.ts'

const relay = (p: Partial<ApiConfig> = {}) =>
  ApiConfig.parse({ id: 'r', name: 'relay', apiKey: 'sk-xxxx', models: ['m'], ...p })

test('老配置没有 endpoints：只支持 protocol 那一种，地址是 baseUrl', () => {
  const a = relay({ protocol: 'anthropic', baseUrl: 'https://a.example.com' })
  assert.deepEqual(apiProtocols(a), ['anthropic'])
  assert.equal(apiEndpoint(a, 'anthropic'), 'https://a.example.com')
  assert.equal(apiEndpoint(a, 'openai-chat'), '')
})

test('勾选几种协议：主协议跟着排在最前的走，最后一种不能取消', () => {
  const a = relay({ protocol: 'openai-chat', baseUrl: 'https://c.example.com/v1' })
  const both = {
    ...a,
    ...withEndpoints(a, { 'openai-chat': 'https://c.example.com/v1', anthropic: 'https://a.example.com' }),
  }
  assert.deepEqual(apiProtocols(both), ['anthropic', 'openai-chat'])
  assert.equal(both.protocol, 'anthropic')
  assert.equal(both.baseUrl, 'https://a.example.com')
  // 全取消时保留原来的主协议
  const none = withEndpoints(both, {})
  assert.deepEqual(Object.keys(none.endpoints ?? {}), ['anthropic'])
})

test('Agent 用 API 的哪种协议：选过的优先，没选过用主协议或第一种两边都支持的', () => {
  const a = relay({
    protocol: 'anthropic',
    endpoints: { anthropic: 'https://a.example.com', 'openai-responses': 'https://r.example.com/v1' },
  })
  const claude = getCli('claude')!.auth
  const codex = getCli('codex')!.auth
  assert.equal(cliApiProtocol(claude, a), 'anthropic')
  // Codex 只能用 Responses：主协议它用不了，换成两边都支持的那种
  assert.equal(cliApiProtocol(codex, a), 'openai-responses')
  // 选的协议 API 已经不支持了：退回默认
  assert.equal(cliApiProtocol(codex, a, 'openai-chat'), 'openai-responses')
  assert.equal(cliApiProtocol(codex, relay({ protocol: 'anthropic' })), undefined)
})

test('cliSettings 按选的协议换地址：交给 Agent 的是那种协议的地址', () => {
  const api = {
    ...relay(),
    protocol: 'anthropic' as const,
    endpoints: { anthropic: 'https://a.example.com', 'openai-chat': 'https://c.example.com/v1' },
  }
  const settings = Settings.parse({
    apis: [api],
    clis: { commandcode: { authMode: 'api', apiId: 'r', apiProtocol: 'openai-chat' } },
  })
  const cs = cliSettings(settings, 'commandcode')
  assert.equal(cs.api?.protocol, 'openai-chat')
  assert.equal(cs.api?.baseUrl, 'https://c.example.com/v1')
})

test('几种协议一起过滤模型：有一种协议对得上就保留', () => {
  assert.deepEqual(modelsForProtocols(['a-responses', 'b-chat', 'c'], ['openai-responses', 'anthropic']), [
    'a-responses',
    'c',
  ])
})

test('各协议分配不同的可选模型：Agent 选了哪种协议只列那种协议的模型，没分配的都能用', () => {
  const api = relay({
    protocol: 'anthropic',
    endpoints: { anthropic: '', 'openai-chat': '' },
    models: ['claude-x', 'gpt-y', 'shared-z'],
    modelProtocols: { 'claude-x': ['anthropic'], 'gpt-y': ['openai-chat'] },
  })
  assert.deepEqual(apiModelsForProtocol(api, 'anthropic'), ['claude-x', 'shared-z'])
  const settings = Settings.parse({
    apis: [api],
    clis: { commandcode: { authMode: 'api', apiId: 'r', apiProtocol: 'openai-chat' } },
  })
  assert.deepEqual(cliSettings(settings, 'commandcode').api?.models, ['gpt-y', 'shared-z'])
})

test('界面显示的模型名：配了映射显示映射到的模型，带 provider 前缀的也能找到；没配照原样', () => {
  const api = relay({ models: ['relay-x', 'plain'], modelMap: { 'relay-x': 'claude-sonnet-5-5' } })
  assert.equal(shownModelName('relay-x', api), 'claude-sonnet-5-5')
  assert.equal(shownModelName('agentpanel/relay-x', api), 'claude-sonnet-5-5')
  assert.equal(shownModelName('plain', api), 'plain')
  const settings = Settings.parse({ apis: [api], clis: { claude: { authMode: 'api', apiId: 'r' } } })
  assert.equal(
    modelText({ cli: 'claude', model: 'relay-x' }, settings, (m) => shownModelName(m, api)),
    'claude-sonnet-5-5',
  )
})
