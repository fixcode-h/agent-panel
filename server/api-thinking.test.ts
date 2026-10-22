import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录和 Pi 的配置目录都换成临时的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-thinking-'))
const pi = path.join(dir, 'pi')
process.env.AGENT_PANEL_DATA = path.join(dir, 'data')
process.env.PI_CODING_AGENT_DIR = pi
mkdirSync(process.env.AGENT_PANEL_DATA, { recursive: true })
mkdirSync(pi, { recursive: true })
writeFileSync(
  path.join(process.env.AGENT_PANEL_DATA, 'settings.json'),
  JSON.stringify({
    apis: [
      {
        id: 'a1',
        name: 'tokenapi',
        protocol: 'openai-responses',
        baseUrl: 'https://tokenapi.example.com/v1',
        apiKey: 'k',
        models: ['gpt-6.1-sol', 'gpt-5.6-sol', 'custom-x'],
        modelEfforts: { 'gpt-5.6-sol': 'high', 'custom-x': 'low' },
      },
    ],
    clis: { pi: { enabled: true, authMode: 'api', apiId: 'a1' } },
  }),
  'utf8',
)
// 用户自己的 Pi 设置和别的 provider 的模型强度要保留；这个 provider 下已经不在 API 里的模型要删掉
writeFileSync(
  path.join(pi, 'settings.json'),
  JSON.stringify({
    theme: 'dark',
    modelThinkingLevels: { 'other/m': 'low', 'tokenapi/old-model': 'high' },
  }),
  'utf8',
)

const { applyApiToClis } = await import('./accounts.ts')

test('一键更新给 Pi 写思考强度：每档取值表和每个模型的默认强度', async () => {
  assert.deepEqual(await applyApiToClis('a1'), ['pi'])
  const models = JSON.parse(readFileSync(path.join(pi, 'models.json'), 'utf8'))
  const list = models.providers.tokenapi.models as Record<string, unknown>[]
  const sol = list.find((m) => m.id === 'gpt-6.1-sol')!
  assert.equal(sol.reasoning, true)
  // 目录里 gpt-6.1-sol 支持 low~xhigh：xhigh 要写出来 Pi 才认，minimal / max 写 null
  assert.deepEqual(sol.thinkingLevelMap, {
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: null,
  })
  // 目录里不认识的模型不动
  const custom = list.find((m) => m.id === 'custom-x')!
  assert.equal(custom.thinkingLevelMap, undefined)

  const settings = JSON.parse(readFileSync(path.join(pi, 'settings.json'), 'utf8'))
  assert.equal(settings.theme, 'dark')
  assert.deepEqual(settings.modelThinkingLevels, {
    'other/m': 'low',
    'tokenapi/gpt-6.1-sol': 'medium',
    'tokenapi/gpt-5.6-sol': 'high',
    'tokenapi/custom-x': 'low',
  })
})
