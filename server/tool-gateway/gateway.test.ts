/**
 * 工具网关套在钩子回答外面（ADR 0084）：回答原样返回、出错放行并记一条、谁拒绝的和推了什么记进去、
 * 工具后按名字 + 输入配对补上用时、同一轮里串行的只读调用标出来。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-gateway-'))

const { openGateway } = await import('./gateway.ts')
const { clearCalls, recentCalls } = await import('./call-log.ts')
const { noteTrigger } = await import('../hooks/run.ts')
const { recordSkillPush } = await import('../skills/push-ledger.ts')

const facts = (name: string, input: Record<string, unknown>, kind: 'shell' | 'read' | 'any' = 'shell') => ({
  tool: { kind, name, input, path: String(input.file_path ?? ''), paths: [] },
})
const ctx = (over: Record<string, unknown> = {}) => ({
  mode: 'observe' as const,
  task: { id: 't1', title: '对话' },
  projectId: 'p1',
  cliId: 'claude',
  spec: { searchTools: ['Grep', 'Glob'] },
  claimCtx: async () => ({ customTools: [] }),
  ...over,
})
const trigger = (hookId: string, result: 'deny' | 'context', detail: string) =>
  noteTrigger({ at: '', hookId, name: hookId, event: 'tool.before', taskId: 't1', result, detail, ms: 0 })

test('关着时不开网关；开着时工具前、工具后都装，所有类别的工具都进来', () => {
  assert.equal(openGateway(ctx({ mode: 'off' })), undefined)
  const gw = openGateway(ctx())!
  assert.deepEqual(gw.events(['tool.before', 'turn.end' as never], new Set()), [
    'tool.before',
    'turn.end',
    'tool.after',
  ])
  assert.deepEqual(gw.events([], new Set(['tool.after' as never])), ['tool.before'], 'CLI 关掉的事件照旧不装')
  assert.deepEqual(gw.tools({ 'tool.before': ['shell'] }), { 'tool.before': ['shell', 'any'], 'tool.after': ['any'] })
})

test('回答原样返回；谁拒绝的、补了哪些说明、推了哪些技能记进记录；改道只推算', async () => {
  clearCalls()
  const gw = openGateway(ctx())!
  const denyAnswer = { deny: true, reason: '不许推 main' }
  const onHook = gw.wrap(async () => {
    trigger('builtin:push-guard', 'deny', '不许推 main')
    return denyAnswer
  })
  assert.equal(await onHook('tool.before', facts('Bash', { command: 'git push origin main' })), denyAnswer)
  const passAnswer = { context: '这一块的教训……' }
  const onHook2 = gw.wrap(async () => {
    trigger('builtin:knowledge', 'context', '这一块的教训……')
    recordSkillPush('t1', {
      skill: 'lua-code-style',
      chars: 2400,
      tokens: 1700,
      at: new Date().toISOString(),
      trigger: 'path',
    })
    return passAnswer
  })
  assert.equal(await onHook2('tool.before', facts('Bash', { command: 'rg -n OnSellAll Content' })), passAnswer)
  const [rg, push] = recentCalls('p1')
  assert.equal(push.decision, 'deny')
  assert.equal(push.denyBy, 'builtin:push-guard')
  assert.equal(rg.decision, 'pass', '观察模式下实际决定还是放行')
  assert.deepEqual(rg.wouldRoute, { capability: 'find', decision: 'rewrite', to: 'find', by: 'rg' })
  assert.deepEqual(rg.pushes, [{ id: 'builtin:knowledge', chars: '这一块的教训……'.length }])
  assert.deepEqual(rg.skills, [{ skill: 'lua-code-style', chars: 2400, tokens: 1700 }])
  assert.ok(rg.ms >= 0 && rg.hookMs! >= rg.ms, '网关自身耗时不超过整个工具前回答')
})

test('网关出错放行：认不出调用、项目事实取不到都照样返回原回答，并记一条', async () => {
  clearCalls()
  const answer = { context: 'x' }
  const boom = openGateway(
    ctx({
      resolveMcp: async () => {
        throw new Error('服务表读不出来')
      },
    }),
  )!
  assert.equal(await boom.wrap(async () => answer)('tool.before', facts('whatever', {}, 'any')), answer)
  assert.equal(recentCalls('p1')[0].error, '服务表读不出来')
  const noClaim = openGateway(
    ctx({
      claimCtx: async () => {
        throw new Error('自建工具表坏了')
      },
    }),
  )!
  assert.equal(
    await noClaim.wrap(async () => answer)('tool.before', facts('Bash', { command: 'luac -p a.lua' })),
    answer,
  )
  assert.equal(recentCalls('p1')[0].capability, 'verify', '取不到项目事实时按没有自建工具推算')
  // 别的事件不经网关
  let seen = ''
  await boom.wrap(async (e) => ((seen = e), {}))('turn.end' as never, {})
  assert.equal(seen, 'turn.end')
  assert.equal(recentCalls('p1').length, 2)
})

test('工具后按名字 + 输入配对补上用时和失败；上一个只读执行完才发下一个算本可以并行', async () => {
  clearCalls()
  const gw = openGateway(ctx())!
  const on = gw.wrap(async () => ({}))
  const read = facts('Read', { file_path: 'a.lua' }, 'read')
  await on('tool.before', read)
  await new Promise((r) => setTimeout(r, 5))
  await on('tool.after', { tool: { ...read.tool, result: { output: '', failed: false } } })
  await on('tool.before', facts('Read', { file_path: 'b.lua' }, 'read'))
  const [b, a] = recentCalls('p1')
  assert.ok(a.durMs! >= 1)
  assert.equal(a.failed, false)
  assert.equal(b.serial, true)
  assert.equal(a.serial, undefined)
  // 另开一轮不和上一轮比
  await openGateway(ctx())!.wrap(async () => ({}))('tool.before', facts('Read', { file_path: 'c.lua' }, 'read'))
  assert.equal(recentCalls('p1')[0].serial, undefined)
})
