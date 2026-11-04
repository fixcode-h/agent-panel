import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录和 Pi 的配置目录都换成临时的：prepareAuth 会真的读写 models.json，不能碰本机配置
const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-pi-config-'))
const piDir = mkdtempSync(path.join(tmpdir(), 'agent-panel-pi-agent-'))
process.env.AGENT_PANEL_DATA = dataDir
process.env.PI_CODING_AGENT_DIR = piDir
mkdirSync(dataDir, { recursive: true })
mkdirSync(piDir, { recursive: true })

const { ApiConfig } = await import('../shared/accounts.ts')
const { prepareAuth } = await import('./accounts.ts')
const { getSettings, saveSettings } = await import('./settings.ts')

type Provider = { baseUrl?: string; models?: Array<{ baseUrl?: string }> }
type Providers = Record<string, Provider>
const modelsFile = path.join(piDir, 'models.json')
const readModels = () => JSON.parse(readFileSync(modelsFile, 'utf8')) as { providers: Providers }
/** Pi 的 schema：baseUrl 只在出现时要求至少 1 个字符，provider 和 models 条目都可以不带 */
const urlsValid = (providers: Providers) =>
  Object.values(providers).every(
    (p) =>
      (p.baseUrl === undefined || (typeof p.baseUrl === 'string' && p.baseUrl.length > 0)) &&
      (p.models ?? []).every((m) => m.baseUrl === undefined || (typeof m.baseUrl === 'string' && m.baseUrl.length > 0)),
  )

/** 把 Pi 切到 API 方式，并选中一个 API */
async function usePiApi(api: Record<string, unknown>) {
  const s = await getSettings()
  await saveSettings({
    ...s,
    apis: [ApiConfig.parse(api)],
    clis: {
      ...s.clis,
      pi: { ...s.clis.pi, enabled: true, authMode: 'api', apiId: String(api.id), apiProtocol: 'openai-chat' },
    },
  })
}

test('写 Pi 配置前只删空的 baseUrl 键，再写入合法 provider', async () => {
  writeFileSync(
    modelsFile,
    JSON.stringify({
      providers: {
        // 内置 provider 的空地址键会让整份文件失效；provider 和 models 要保留
        deepseek: { baseUrl: '', api: 'openai-completions', models: [{ id: 'deepseek-chat' }] },
        // 内置 provider 不带地址本来就合法
        anthropic: { modelOverrides: { 'claude-opus-4-7': { reasoning: true } } },
        mine: { baseUrl: 'https://mine.example.com/v1', api: 'openai-completions', models: [] },
      },
    }),
  )
  await usePiApi({
    id: 'open-design',
    name: 'OpenDesign',
    provider: 'opendesign',
    protocol: 'openai-chat',
    baseUrl: 'https://amr-link.open-design.ai/v1',
    apiKey: 'sk-x',
    models: ['deepseek-v4.1-flash'],
  })
  await prepareAuth('pi')
  const { providers } = readModels()
  // 空键被删掉，provider 和模型都保留；没带地址的 provider 不受影响
  assert.equal(providers.deepseek.baseUrl, undefined)
  assert.deepEqual(providers.deepseek.models, [{ id: 'deepseek-chat' }])
  assert.ok(providers.anthropic)
  assert.ok(providers.mine)
  // 写进去的 provider 带非空地址，整份文件里每个 baseUrl 都合法
  assert.equal(providers.opendesign.baseUrl, 'https://amr-link.open-design.ai/v1')
  assert.ok(urlsValid(providers))
})

test('API 没有接口地址时不写 provider，并清掉面板以前写过的旧地址', async () => {
  writeFileSync(
    modelsFile,
    JSON.stringify({
      providers: {
        relay: { baseUrl: 'https://old.example.com/v1', api: 'openai-completions', models: [{ id: 'old' }] },
        mine: { baseUrl: 'https://mine.example.com/v1', api: 'openai-completions' },
      },
    }),
  )
  // 名称对不上内置厂家、地址也留空：apiBaseUrl 给不出地址
  await usePiApi({
    id: 'relay',
    name: '自建中转',
    provider: 'relay',
    protocol: 'openai-chat',
    baseUrl: '',
    apiKey: 'sk-x',
    models: ['m'],
  })
  await prepareAuth('pi')
  const { providers } = readModels()
  // 旧 provider 被清掉：不会继续把请求和密钥发给用户已经清掉的旧地址
  assert.equal(providers.relay, undefined)
  assert.ok(providers.mine)
  assert.ok(urlsValid(providers))
})
