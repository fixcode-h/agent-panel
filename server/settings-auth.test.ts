import test from 'node:test'
import assert from 'node:assert/strict'
import { cliSettings } from '../shared/settings.ts'
import { Settings } from '../shared/schema.ts'

const api = {
  id: 'tokenapi',
  name: 'TokenAPI',
  provider: 'tokenapi',
  protocol: 'openai-responses' as const,
  baseUrl: 'https://tokenapi.example.test',
  apiKey: 'test-key',
  authHeader: 'x-api-key' as const,
  models: ['deepseek/deepseek-v4-flash-responses'],
}

test('Command Code 账号模式会把 API 模型映射为账号模型', () => {
  const settings = Settings.parse({
    apis: [api],
    clis: {
      commandcode: {
        authMode: 'account',
        apiId: api.id,
        tiers: {
          high: { model: 'tokenapi/deepseek/deepseek-v4-flash-responses' },
          medium: { model: 'tokenapi/deepseek/deepseek-v4-flash-responses' },
          low: { model: 'tokenapi/deepseek/deepseek-v4-flash-responses' },
        },
      },
    },
  })

  const effective = cliSettings(settings, 'commandcode')

  assert.equal(effective.tiers.high.model, 'deepseek/deepseek-v4-flash')
  assert.equal(effective.tiers.medium.model, 'deepseek/deepseek-v4-flash')
  assert.equal(effective.tiers.low.model, 'deepseek/deepseek-v4-flash')
  assert.equal(effective.api, undefined)
})
