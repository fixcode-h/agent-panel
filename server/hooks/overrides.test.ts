/**
 * 用户放行（ADR 0070）：门禁拦下时记下拦了什么，用户在卡片上同意后同一个门禁放行一次。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-overrides-'))

const { gateDeny, overrideRequest, targetOf } = await import('./overrides.ts')
const { replies } = await import('../exec/panel-requests.ts')
type Task = import('../../shared/schema.ts').Task

const ctxOf = (id: string) => {
  const task = { id, requests: [] } as unknown as Task
  let n = 0
  return { task, signal: new AbortController().signal, newId: () => `${id}-r${++n}`, changed: () => {} }
}

const shell = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
})

test('没放行时：原因后面附上请用户放行的提示，门禁名写在里面', () => {
  const deny = gateDeny({ id: 't1' }, 'danger-guard', '危险命令守卫', 'rm -rf /', '【面板】会递归删除整个目录')
  assert.match(deny, /^【面板】会递归删除整个目录/)
  assert.match(deny, /request_override/)
  assert.match(deny, /"danger-guard"/)
  // 没拦（原因是空串）就不附提示
  assert.equal(gateDeny({ id: 't1' }, 'danger-guard', '危险命令守卫', '', ''), '')
})

test('用户在卡片上同意后放行一次，卡片上是面板记下的操作，用掉就没了', async () => {
  const ctx = ctxOf('t2')
  gateDeny({ id: 't2' }, 'danger-guard', '危险命令守卫', targetOf(shell('rm -rf build')), '【面板】会递归删除整个项目')
  const p = overrideRequest(ctx, { gate: 'danger-guard', reason: '用户说：直接删掉 build 目录' })
  const req = ctx.task.requests[0]
  assert.equal(req.purpose, 'override')
  assert.match(req.detail, /rm -rf build/)
  assert.match(req.detail, /直接删掉 build 目录/)
  replies.get(req.id)!({ allow: true })
  const r = await p
  assert.equal(r.ok, true)
  assert.equal(gateDeny({ id: 't2' }, 'danger-guard', '危险命令守卫', 'rm -rf build', '【面板】会递归删除整个项目'), '')
  // 只放行一次
  assert.notEqual(
    gateDeny({ id: 't2' }, 'danger-guard', '危险命令守卫', 'rm -rf build', '【面板】会递归删除整个项目'),
    '',
  )
})

test('用户拒绝、没被拦过、没写理由：都不放行', async () => {
  const ctx = ctxOf('t3')
  const none = await overrideRequest(ctx, { gate: 'push-guard', reason: '用户要推' })
  assert.equal(none.ok, false)
  assert.match(none.info, /没有拦过你/)
  gateDeny({ id: 't3' }, 'push-guard', '推送授权守卫', 'git push', '【面板】项目设置是「不推送」')
  assert.equal((await overrideRequest(ctx, { gate: 'push-guard', reason: ' ' })).ok, false)
  const p = overrideRequest(ctx, { gate: 'push-guard', reason: '用户要推' })
  replies.get(ctx.task.requests[0].id)!({ allow: false, message: '先别推' })
  const r = await p
  assert.equal(r.ok, false)
  assert.match(r.info, /先别推/)
  assert.notEqual(gateDeny({ id: 't3' }, 'push-guard', '推送授权守卫', 'git push', '【面板】项目设置是「不推送」'), '')
})

test('本对话不再询问：规则记进对话，同一个门禁之后都不拦，别的门禁照拦，新对话重新问', async () => {
  const ctx = ctxOf('t4')
  gateDeny(ctx.task, 'read-only-guard', '只读身份守卫', 'a.ts', '【面板】只读角色不能改文件')
  const p = overrideRequest(ctx, { gate: 'read-only-guard', reason: '用户说：直接改' })
  const req = ctx.task.requests[0]
  assert.equal(req.rule, 'gate:read-only-guard')
  assert.match(req.ruleLabel ?? '', /只读身份守卫/)
  replies.get(req.id)!({ allow: true, always: true })
  const r = await p
  assert.equal(r.ok, true)
  assert.match(r.info, /之后都不再拦/)
  assert.deepEqual(ctx.task.allowRules, ['gate:read-only-guard'])
  for (let i = 0; i < 3; i++)
    assert.equal(gateDeny(ctx.task, 'read-only-guard', '只读身份守卫', 'b.ts', '【面板】只读角色不能改文件'), '')
  assert.notEqual(gateDeny(ctx.task, 'danger-guard', '危险命令守卫', 'rm -rf x', '【面板】会删目录'), '')
  assert.notEqual(gateDeny({ id: 't5' }, 'read-only-guard', '只读身份守卫', 'b.ts', '【面板】只读角色不能改文件'), '')
})
