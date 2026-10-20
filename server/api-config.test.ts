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
  sameApi,
  setModelEfforts,
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
