import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTestEnv, cleanedLine } from './test-env.mjs'

test('测试环境：去掉继承的接口、面板和 git 变量，保留其他变量，只报名字', () => {
  const { env, removed } = cleanTestEnv({
    PATH: '/bin',
    HTTPS_PROXY: 'http://proxy',
    GIT_SSL_CAINFO: '/ca.crt',
    ANTHROPIC_BASE_URL: 'https://x',
    OPENAI_API_KEY: 'sk-xxxx',
    CLAUDE_CODE_REMOTE: '1',
    AGENT_PANEL_DATA: '/tmp/d',
    AGENT_PANEL_TRAY: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_DIR: '/repo/.git',
    GIT_INDEX_FILE: '/repo/.git/index',
  })
  assert.deepEqual(Object.keys(env).sort(), ['GIT_SSL_CAINFO', 'HTTPS_PROXY', 'PATH'])
  assert.deepEqual(removed.sort(), [
    'AGENT_PANEL_DATA',
    'AGENT_PANEL_TRAY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_REMOTE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'OPENAI_API_KEY',
  ])
  assert.equal(cleanedLine('[unit]', ['B', 'A']), '[unit] 去掉了继承的环境变量：A、B')
  assert.equal(cleanedLine('[unit]', []), '')
  // 同一类多了按前缀合并，日志不被几十个变量名刷屏
  assert.equal(
    cleanedLine('[e2e]', ['CLAUDE_CODE_A', 'CLAUDE_CODE_B', 'CLAUDE_CODE_C', 'CLAUDE_CODE_D', 'GIT_DIR']),
    '[e2e] 去掉了继承的环境变量：CLAUDE_CODE_*（4 个）、GIT_DIR',
  )
})

test('测试环境：测试入口自己的开关留着，给分片读', () => {
  const keep = { AGENT_PANEL_E2E_WATCHDOG_MS: '1', AGENT_PANEL_UI_DEMO_SPEED: '4', AGENT_PANEL_UNIT_CONCURRENCY: '2' }
  assert.deepEqual(cleanTestEnv(keep).env, keep)
})
