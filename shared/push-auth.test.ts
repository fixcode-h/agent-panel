import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orchAskPush, pushPolicyText } from './push-auth.ts'
import type { EngineHost } from './engine-host.ts'

const policy = (x: Partial<NonNullable<EngineHost['policy']>>) => ({ push: 'ask' as const, tools: [], ...x })

test('没有远端的 Git 仓库：推送规则写明不推、不问，也不给 ask_push', () => {
  const text = pushPolicyText(policy({ noRemote: true }), '', '')
  assert.match(text, /没有配置远端/)
  assert.match(text, /不问用户要不要推送/)
  assert.doesNotMatch(text, /调用面板工具 ask_push/)
  const host = (p: NonNullable<EngineHost['policy']>) =>
    ({ task: { projectId: 'p' }, policy: p, askPush: async () => ({ allow: true }) }) as unknown as EngineHost
  assert.equal(orchAskPush(host(policy({ noRemote: true })), true, false), undefined)
  // 有远端的「问一次」项目照旧给
  assert.equal(typeof orchAskPush(host(policy({})), true, false), 'function')
  assert.match(pushPolicyText(policy({}), '', ''), /ask_push/)
})
