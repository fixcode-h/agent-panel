import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTestEnv } from './test-env.mjs'

test('测试环境：去掉继承的接口变量，保留其他变量，只报名字', () => {
  const { env, removed } = cleanTestEnv({
    PATH: '/bin',
    HTTPS_PROXY: 'http://proxy',
    ANTHROPIC_BASE_URL: 'https://x',
    OPENAI_API_KEY: 'sk-xxxx',
    CLAUDE_CODE_REMOTE: '1',
    AGENT_PANEL_DATA: '/tmp/d',
  })
  assert.deepEqual(Object.keys(env).sort(), ['AGENT_PANEL_DATA', 'HTTPS_PROXY', 'PATH'])
  assert.deepEqual(removed.sort(), ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_REMOTE', 'OPENAI_API_KEY'])
})
