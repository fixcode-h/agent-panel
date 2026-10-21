import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { getCli } from '../shared/clis.ts'
import {
  ApiConfig,
  CliAuth,
  apiInjection,
  apiModelIdFor,
  apiModelList,
  apiProvider,
  fillEdits,
  modelForProtocol,
  modelsForProtocol,
  pruneModelEntries,
  pruneProviderEntries,
  sameApi,
  setModelEfforts,
  setModelLimits,
} from '../shared/accounts.ts'
import { mergeJson, fetchApiModels } from './accounts.ts'
import { toApi } from './api-detect.ts'
import { agentRun, defaultSettings } from '../shared/settings.ts'
import { CliSettings } from '../shared/schema.ts'

const auth = CliAuth.parse({
  home: '~',
  api: {
    protocols: ['openai-responses'],
    defaultProvider: 'agentpanel',
    modelSource: 'cli',
    modelPrefix: '{provider}/',
    env: { KEY: '{apiKey}' },
    args: ['--provider', '{provider}'],
    edits: [
      {
        file: 'providers.json',
        merge: true,
        set: {
          'provider.{provider}': {
            name: '{name}',
            baseURL: '{baseUrl}',
            api: '{wire}',
            models: '{models}',
          },
        },
      },
    ],
    wire: { 'openai-responses': 'openai-responses' },
  },
})

test('API provider：显式值优先，否则从 API 名称生成', () => {
  const a = ApiConfig.parse({ id: '1', name: 'CodeG', models: [] })
  assert.equal(apiProvider(a), 'codeg')
  assert.equal(apiProvider({ ...a, provider: 'tokenapi' }), 'tokenapi')
})

test('API 注入：provider 写进配置键，provider 前缀的模型在 provider 配置里去掉前缀', () => {
  const api = ApiConfig.parse({
    id: '1',
    name: 'codeg',
    protocol: 'openai-responses',
    baseUrl: 'https://example.com/v1',
    apiKey: 'k',
    models: ['deepseek/deepseek-v4-flash-responses', 'codeg/gpt-6-astra'],
  })
  const inj = apiInjection(auth, api)
  assert.deepEqual(inj.args, ['--provider', 'codeg'])
  assert.deepEqual((inj.edits[0].set['provider.codeg'] as any).models, {
    'deepseek/deepseek-v4-flash-responses': {},
    'gpt-6-astra': {},
  })
  assert.equal(inj.edits[0].merge, true)
})

test('API 模型 ID：显示和传给 CLI 时补 provider 前缀，已经有的不重复', () => {
  const api = ApiConfig.parse({ id: '1', name: 'codeg', models: ['a', 'codeg/b'] })
  assert.deepEqual(apiModelList(api, 'codeg/'), ['codeg/a', 'codeg/b'])
})

test('API 模式模型：旧的无前缀 ID 补当前 provider，已带前缀和档位不动', () => {
  const api = ApiConfig.parse({ id: '1', name: 'codeg', models: ['deepseek/x', 'gpt-6.1-sol'] })
  const auth = CliAuth.parse({
    home: '~',
    api: { protocols: ['openai-responses'], modelPrefix: '{provider}/' },
  })
  assert.equal(apiModelIdFor('deepseek/x', auth, api), 'codeg/deepseek/x')
  assert.equal(apiModelIdFor('codeg/gpt-6.1-sol', auth, api), 'codeg/gpt-6.1-sol')
  assert.equal(apiModelIdFor('@high', auth, api), '@high')
})

test('识别 API：provider 用 CLI 配置里的键', () => {
  const def = getCli('commandcode')!
  const src = def.auth!.apiSources.find((s) => s.file.includes('providers.json'))!
  const api = toApi(
    def,
    src,
    'tokenapi',
    {
      name: 'HappyElements TokenAPI',
      baseURL: 'https://tokenapi.example.com',
      apiKey: 'k',
      api: 'anthropic-messages',
      models: { 'deepseek/deepseek-v4-flash': {} },
    },
    {},
  )!
  assert.equal(api.provider, 'tokenapi')
  assert.deepEqual(api.models, ['deepseek/deepseek-v4-flash'])
})

test('账号还原：provider 占位用最后选用的 API 填', () => {
  const api = ApiConfig.parse({ id: '1', name: 'codeg' })
  const edits = fillEdits(
    [{ file: 'x.json', format: 'json', set: {}, merge: false, unset: ['provider.{provider}'] }],
    auth,
    api,
  )
  assert.deepEqual(edits[0].unset, ['provider.codeg'])
})

test('账号还原：API 已被移除时仍按上一次的 provider 删除接口', () => {
  const edits = fillEdits(
    [{ file: 'x.json', format: 'json', set: {}, merge: false, unset: ['provider.{provider}'] }],
    auth,
    undefined,
    'cc',
  )
  assert.deepEqual(edits[0].unset, ['provider.cc'])
})

test('识别 API：面板自己写入的 provider 不算', () => {
  const def = getCli('commandcode')!
  const src = def.auth!.apiSources.find((s) => s.file.includes('providers.json'))!
  assert.equal(
    toApi(
      def,
      src,
      'codeg',
      { baseURL: 'https://example.com', apiKey: 'k', api: 'openai-responses', models: { a: {} } },
      {},
      new Set(['codeg']),
    ),
    null,
  )
})

test('JSON 编辑 merge：保留已有 provider 的模型元数据', () => {
  const base = { provider: { codeg: { name: 'old', models: { a: { contextWindow: 1000 } } } } }
  const patch = { provider: { codeg: { name: 'new', models: { a: {}, b: {} } } } }
  assert.deepEqual(mergeJson(base, patch), {
    provider: { codeg: { name: 'new', models: { a: { contextWindow: 1000 }, b: {} } } },
  })
})

test('同一个 API：地址和密钥一样就算，协议和 /v1 不影响', () => {
  assert.ok(sameApi({ baseUrl: 'https://x.example', apiKey: 'k' }, { baseUrl: 'https://x.example/v1/', apiKey: 'k' }))
  assert.ok(!sameApi({ baseUrl: 'https://x.example', apiKey: 'k' }, { baseUrl: 'https://x.example/v1', apiKey: 'k2' }))
  assert.ok(!sameApi({ baseUrl: 'https://x.example/a', apiKey: 'k' }, { baseUrl: 'https://x.example/b', apiKey: 'k' }))
})

test('按协议过滤模型：不带后缀通用，别的协议后缀隐藏，换协议自动换后缀', () => {
  const all = ['x', 'x-anthropic', 'x-anthropic-messages', 'x-responses', 'x-chat', 'x-gemini']
  assert.deepEqual(modelsForProtocol(all, 'anthropic'), ['x', 'x-anthropic', 'x-anthropic-messages'])
  assert.deepEqual(modelsForProtocol(all, 'openai-responses'), ['x', 'x-responses'])
  assert.deepEqual(modelsForProtocol(all, 'openai-chat'), ['x', 'x-chat'])
  assert.deepEqual(modelsForProtocol(all, 'gemini'), ['x', 'x-gemini'])
  const a = modelsForProtocol(all, 'anthropic')
  assert.equal(modelForProtocol('x-responses', 'anthropic', a), 'x-anthropic')
  assert.equal(modelForProtocol('x', 'anthropic', a), 'x')
  assert.equal(modelForProtocol('unknown', 'anthropic', a), 'x')
})

test('换协议时没有对应后缀，就用同名的通用模型，不跳到列表第一个', () => {
  const models = ['gpt-6.1-sol', 'deepseek/deepseek-v4-flash-responses', 'deepseek/deepseek-v4-flash']
  const allowed = modelsForProtocol(models, 'openai-chat')
  assert.deepEqual(allowed, ['gpt-6.1-sol', 'deepseek/deepseek-v4-flash'])
  assert.equal(
    modelForProtocol('deepseek/deepseek-v4-flash-responses', 'openai-chat', allowed),
    'deepseek/deepseek-v4-flash',
  )
})

test('只留一份接口配置：同地址和密钥的旧 provider 删掉，不同接口保留', () => {
  const data = {
    provider: {
      active: { baseURL: 'https://x.example', apiKey: 'k' },
      old: { baseURL: 'https://x.example/v1', apiKey: 'k' },
      other: { baseURL: 'https://y.example', apiKey: 'k' },
    },
  }
  const keys = { baseUrl: 'baseURL', apiKey: 'apiKey' }
  assert.equal(
    pruneProviderEntries(data, 'provider', 'active', { baseUrl: 'https://x.example', apiKey: 'k' }, keys),
    true,
  )
  assert.deepEqual(Object.keys(data.provider), ['active', 'other'])
  assert.equal(
    pruneProviderEntries(data, 'provider', 'active', { baseUrl: 'https://x.example', apiKey: 'k' }, keys),
    false,
  )
  // 正在用的 provider 不在配置里时不动，避免把配置删空
  const missing = { provider: { old: { baseURL: 'https://x.example', apiKey: 'k' } } }
  assert.equal(
    pruneProviderEntries(missing, 'provider', 'active', { baseUrl: 'https://x.example', apiKey: 'k' }, keys),
    false,
  )
})

test('只留一份接口配置：密钥是面板旧占位名的 provider 只看地址也能删掉', () => {
  const data = {
    providers: {
      tokenapi: { baseUrl: 'https://tokenapi.happyelements.net', apiKey: 'sk-real' },
      codeg: { baseUrl: 'https://tokenapi.happyelements.net/v1', apiKey: 'AGENT_PANEL_API_KEY' },
      other: { baseUrl: 'https://y.example', apiKey: 'AGENT_PANEL_API_KEY' },
    },
  }
  const keys = { baseUrl: 'baseUrl', apiKey: 'apiKey' }
  assert.equal(
    pruneProviderEntries(
      data,
      'providers',
      'tokenapi',
      { baseUrl: 'https://tokenapi.happyelements.net', apiKey: 'sk-real' },
      keys,
    ),
    true,
  )
  // 别的接口的旧占位 provider 不动，用户可能还在用
  assert.deepEqual(Object.keys(data.providers), ['tokenapi', 'other'])
})

test('provider 的 models 只保留 API 里配的模型', () => {
  const data = { provider: { tokenapi: { models: { 'gpt-6.1-sol': {}, old: {}, 'gpt-5.6-sol': {} } } } }
  assert.equal(pruneModelEntries(data, 'provider.tokenapi.models', ['gpt-6.1-sol', 'gpt-5.6-sol']), true)
  assert.deepEqual(Object.keys(data.provider.tokenapi.models), ['gpt-6.1-sol', 'gpt-5.6-sol'])
  assert.equal(pruneModelEntries(data, 'provider.tokenapi.models', ['gpt-6.1-sol', 'gpt-5.6-sol']), false)
  // API 没配模型时不动，避免把配置删空
  const empty = { provider: { tokenapi: { models: { 'gpt-6.1-sol': {} } } } }
  assert.equal(pruneModelEntries(empty, 'provider.tokenapi.models', []), false)
})

test('写回思考强度：匹配到的模型按目录重写，不认识的保持原样', () => {
  const data = {
    provider: {
      tokenapi: {
        models: {
          'deepseek/deepseek-v4-flash': { reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
          'deepseek/deepseek-v4-flash-anthropic': {},
          'custom/unknown': {},
        },
      },
    },
  }
  const efforts = new Map([
    ['deepseek/deepseek-v4-flash', ['low', 'high', 'max']],
    ['deepseek/deepseek-v4-flash-anthropic', ['low', 'high', 'max']],
  ])
  const run = () => setModelEfforts(data, 'provider.tokenapi.models', 'reasoningEfforts', (m) => efforts.get(m))
  assert.equal(run(), true)
  assert.deepEqual(data.provider.tokenapi.models['deepseek/deepseek-v4-flash'].reasoningEfforts, ['low', 'high', 'max'])
  assert.deepEqual(data.provider.tokenapi.models['deepseek/deepseek-v4-flash-anthropic'], {
    reasoningEfforts: ['low', 'high', 'max'],
  })
  assert.deepEqual(data.provider.tokenapi.models['custom/unknown'], {})
  // 已经是目标值，第二次不用再改
  assert.equal(run(), false)
})

test('写回上下文窗口：匹配到的模型按目录重写，不认识的保持原样', () => {
  const data = {
    provider: {
      tokenapi: {
        models: {
          'deepseek/deepseek-v4-flash': { contextWindow: 200000 },
          'deepseek/deepseek-v4-flash-anthropic': {},
          'custom/unknown': {},
        },
      },
    },
  }
  const windows = new Map([
    ['deepseek/deepseek-v4-flash', { context: 1000000 }],
    ['deepseek/deepseek-v4-flash-anthropic', { context: 1000000 }],
  ])
  const run = () =>
    setModelLimits(data, 'provider.tokenapi.models', { context: 'contextWindow' }, (m) => windows.get(m))
  assert.equal(run(), true)
  assert.equal(data.provider.tokenapi.models['deepseek/deepseek-v4-flash'].contextWindow, 1000000)
  assert.deepEqual(data.provider.tokenapi.models['deepseek/deepseek-v4-flash-anthropic'], { contextWindow: 1000000 })
  assert.deepEqual(data.provider.tokenapi.models['custom/unknown'], {})
  // 已经是目标值，第二次不用再改
  assert.equal(run(), false)
})

test('写回上下文窗口：Pi 的 models.json 是数组，同时写最大输出', () => {
  const data = {
    providers: {
      tokenapi: {
        models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-sol', name: 'custom' }, { id: 'custom/unknown' }],
      },
    },
  }
  const limits = new Map([
    ['gpt-6.1-sol', { context: 1000000, maxOutput: 128000 }],
    ['custom/unknown', undefined],
  ])
  const run = () =>
    setModelLimits(data, 'providers.tokenapi.models', { context: 'contextWindow', maxOutput: 'maxTokens' }, (m) =>
      limits.get(m),
    )
  assert.equal(run(), true)
  assert.deepEqual(data.providers.tokenapi.models[0], { id: 'gpt-6.1-sol', contextWindow: 1000000, maxTokens: 128000 })
  // 名字和已有的项保留，只补窗口
  assert.deepEqual(data.providers.tokenapi.models[1], {
    id: 'gpt-6.1-sol',
    name: 'custom',
    contextWindow: 1000000,
    maxTokens: 128000,
  })
  assert.deepEqual(data.providers.tokenapi.models[2], { id: 'custom/unknown' })
  assert.equal(run(), false)
})

test('API 测试连接：成功返回模型，失败带状态和原因', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/models') {
      res.end(JSON.stringify({ data: [{ id: 'm-2' }, { id: 'm-1' }] }))
      return
    }
    res.statusCode = 401
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const baseUrl = `http://127.0.0.1:${port}`
  const api = { protocol: 'openai-chat' as const, apiKey: 'k', authHeader: 'x-api-key' as const }
  try {
    assert.deepEqual(await fetchApiModels({ ...api, baseUrl }), ['m-1', 'm-2'])
    await assert.rejects(() => fetchApiModels({ ...api, baseUrl: `${baseUrl}/bad` }), /401.*bad key/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('API 方式：执行时只认 API 里配的模型，其它模型换成第一个并补前缀', () => {
  const s = defaultSettings()
  s.apis = [
    ApiConfig.parse({
      id: 'a1',
      name: '接口',
      provider: 'p',
      protocol: 'openai-responses',
      baseUrl: 'https://x.example',
      apiKey: 'k',
      models: ['cc-1', 'cc-2'],
    }),
  ]
  s.clis.commandcode = CliSettings.parse({ authMode: 'api', apiId: 'a1' })
  assert.equal(agentRun({ cli: 'commandcode', model: 'cc-2' }, s).model, 'p/cc-2')
  assert.equal(agentRun({ cli: 'commandcode', model: 'old-model' }, s).model, 'p/cc-1')
  assert.equal(agentRun({ cli: 'commandcode', model: 'p/cc-2' }, s).model, 'p/cc-2')
})

test('API 方式：模型后缀按协议自动切换', () => {
  const s = defaultSettings()
  s.apis = [
    ApiConfig.parse({
      id: 'a2',
      name: '接口',
      provider: 'p',
      protocol: 'anthropic',
      baseUrl: 'https://x.example',
      apiKey: 'k',
      models: ['m-anthropic', 'm-responses'],
    }),
  ]
  s.clis.commandcode = CliSettings.parse({ authMode: 'api', apiId: 'a2' })
  assert.equal(agentRun({ cli: 'commandcode', model: 'm-responses' }, s).model, 'p/m-anthropic')
  assert.equal(agentRun({ cli: 'commandcode', model: 'm-anthropic' }, s).model, 'p/m-anthropic')
})
