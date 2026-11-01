/**
 * 「关掉思考」那一档：按 CLI 定义里的 off 字段走；模型目录只记思考的各档，能思考的模型照样给「关」。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogEfforts, effortEnv, getCli, isOffEffort, offEffort } from './clis.ts'

const opts = { model: 'deepseek-v4.1-flash', permission: 'acceptEdits', extraArgs: [] }

test('Codex 的「关」是 none，Pi 和 Claude Code 的是 off；按定义判断，不按名字', () => {
  assert.equal(offEffort(getCli('codex')), 'none')
  assert.equal(offEffort(getCli('pi')), 'off')
  assert.equal(offEffort(getCli('claude')), 'off')
  assert.ok(isOffEffort(getCli('codex'), 'none'))
  assert.ok(!isOffEffort(getCli('codex'), 'low'))
  assert.ok(!isOffEffort(getCli('codex'), 'off'))
  // 没有「关」这一档的 CLI 不显示
  assert.equal(offEffort(getCli('commandcode')), undefined)
  // Codex 关思考的参数
  const args = getCli('codex')!.buildArgs({ ...opts, effort: 'none', permission: 'read-only' })
  assert.ok(args.includes('model_reasoning_effort="none"'), args.join(' '))
})

test('Claude Code 关思考：不传 --effort，环境变量让请求带 thinking: disabled', () => {
  const claude = getCli('claude')!
  assert.ok(!claude.buildArgs({ ...opts, effort: 'off' }).includes('--effort'))
  assert.ok(claude.buildArgs({ ...opts, effort: 'high' }).includes('--effort'))
  const env = effortEnv(claude, 'off', { PATH: '/bin' })
  assert.equal(env.MAX_THINKING_TOKENS, '0')
  assert.deepEqual(JSON.parse(env.CLAUDE_CODE_EXTRA_BODY!), { thinking: { type: 'disabled' } })
  assert.equal(env.PATH, '/bin')
  // 其他档不加
  assert.equal(effortEnv(claude, 'high', { PATH: '/bin' }).CLAUDE_CODE_EXTRA_BODY, undefined)
  // 用户自己写的 CLAUDE_CODE_EXTRA_BODY 合并，不被顶掉
  const own = effortEnv(claude, 'off', { CLAUDE_CODE_EXTRA_BODY: '{"top_k":5}' })
  assert.deepEqual(JSON.parse(own.CLAUDE_CODE_EXTRA_BODY!), { top_k: 5, thinking: { type: 'disabled' } })
  // 用户写的不是 JSON 对象时以这一档为准（Claude Code 本来也会忽略不是对象的值）
  const bad = effortEnv(claude, 'off', { CLAUDE_CODE_EXTRA_BODY: 'oops' })
  assert.deepEqual(JSON.parse(bad.CLAUDE_CODE_EXTRA_BODY!), { thinking: { type: 'disabled' } })
})

test('模型目录认识的模型能思考时补上「关」，不能思考的不补', () => {
  // 没有「关」时选了 none 会被换成最近的思考档（low），等于没关
  assert.deepEqual(catalogEfforts(getCli('codex'), ['low', 'high', 'max']), ['none', 'low', 'high', 'max'])
  assert.deepEqual(catalogEfforts(getCli('pi'), ['low', 'high']), ['off', 'low', 'high'])
  assert.deepEqual(catalogEfforts(getCli('claude'), ['low', 'ultra', 'max']), ['off', 'low', 'max'])
  assert.deepEqual(catalogEfforts(getCli('codex'), []), [])
})
