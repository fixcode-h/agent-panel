/**
 * 额度用完、被限流后自动接上的判定（shared/quota-resume.ts）。
 * 运行：npx tsx --test shared/quota-resume.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUOTA_AUTO_MAX,
  QuotaResumeSettings,
  RATE_LIMIT_WAIT_MS,
  RESET_SLACK_MS,
  planQuotaResume,
  quotaFailure,
  resetFromLimits,
  resetFromText,
} from './quota-resume.ts'
import { lifeNext } from './life-next.ts'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const err = (kind: string, detail = '') =>
  ({ id: 'e', role: 'system', alert: { kind, level: 'error', detail } }) as never
const user = { id: 'u1', role: 'user' }

test('只认最后一条红色告警的分类，到用户最近一条消息为止', () => {
  assert.deepEqual(quotaFailure([user, err('quota', 'insufficient_quota')]), {
    kind: 'quota',
    detail: 'insufficient_quota',
  })
  assert.equal(quotaFailure([user, err('network')]), undefined)
  // 用户之后又发了消息：前面的额度失败不算这一轮的
  assert.equal(quotaFailure([err('quota'), user]), undefined)
  // 黄色的重试提示不算失败
  const warn = { id: 'w', role: 'system', alert: { kind: 'rate_limit', level: 'warn' } } as never
  assert.equal(quotaFailure([user, warn]), undefined)
})

test('从报错原文读恢复时间', () => {
  assert.equal(resetFromText('Claude AI usage limit reached|1762860000', NOW), 1762860000 * 1000)
  assert.equal(resetFromText('try again in 1 hour 37 minutes.', NOW), NOW + 97 * 60_000)
  assert.equal(resetFromText('resets in 2 days, upgrade to pro', NOW), NOW + 2 * 86400_000)
  const at = resetFromText("You've hit your limit · resets 3pm", NOW)!
  assert.ok(at > NOW && at - NOW <= 86400_000)
  assert.equal(new Date(at).getHours(), 15)
  assert.equal(resetFromText('quota exceeded', NOW), undefined)
})

test('额度窗口：用满的取最晚的，只标了限流取最早的', () => {
  const w = (usedPercent: number, h: number) => ({ id: String(h), usedPercent, resetsAt: NOW + h * 3600_000 })
  assert.equal(resetFromLimits({ windows: [w(100, 2), w(100, 50), w(40, 1)], at: '' }, NOW), NOW + 50 * 3600_000)
  assert.equal(resetFromLimits({ windows: [w(80, 3), w(60, 1)], limited: true, at: '' }, NOW), NOW + 3600_000)
  assert.equal(resetFromLimits({ windows: [w(80, 3)], at: '' }, NOW), undefined)
})

const base = {
  kind: 'quota' as const,
  detail: '',
  current: { cli: 'claude', model: 'opus' },
  input: 'u1',
  now: NOW,
  usable: () => true,
}

test('备用顺序：两个设置都关时不接；跳过正在用的和用过的，按顺序换', () => {
  assert.deepEqual(planQuotaResume({ ...base, settings: QuotaResumeSettings.parse({}) }), { type: 'none', why: 'off' })
  const settings = QuotaResumeSettings.parse({
    fallback: true,
    order: [
      { cli: 'claude', model: 'opus' },
      { cli: 'codex', model: 'gpt-5' },
      { cli: 'pi', model: '' },
    ],
  })
  const a = planQuotaResume({ ...base, settings })
  assert.equal(a.type, 'switch')
  assert.deepEqual(a.type === 'switch' && a.to, { cli: 'codex', model: 'gpt-5' })
  // 换过去之后又失败：不再换回 opus，也不再用 codex
  const b = planQuotaResume({ ...base, settings, current: { cli: 'codex', model: 'gpt-5' }, state: a.state })
  assert.deepEqual(b.type === 'switch' && b.to, { cli: 'pi', model: '' })
  // 都用过了、没开到点继续：不接
  const c = planQuotaResume({ ...base, settings, current: { cli: 'pi', model: '' }, state: b.state })
  assert.equal(c.type === 'none' && c.why, 'exhausted')
  // 不能用的（CLI 停用、角色固定了 CLI）跳过
  const d = planQuotaResume({ ...base, settings, usable: (f) => f.cli !== 'codex' })
  assert.deepEqual(d.type === 'switch' && d.to, { cli: 'pi', model: '' })
  // 用户发了新消息：从头算
  const e = planQuotaResume({ ...base, settings, input: 'u2', state: b.state })
  assert.deepEqual(e.type === 'switch' && e.to, { cli: 'codex', model: 'gpt-5' })
})

test('到点继续：知道时间就等到点，限流不知道时间等 5 分钟，额度不知道时间不等，次数有上限', () => {
  const settings = QuotaResumeSettings.parse({ waitReset: true })
  const known = planQuotaResume({ ...base, settings, detail: 'try again in 2 hours' })
  assert.equal(known.type, 'wait')
  assert.equal(known.type === 'wait' && known.until, NOW + 2 * 3600_000 + RESET_SLACK_MS)
  const rl = planQuotaResume({ ...base, settings, kind: 'rate_limit' })
  assert.equal(rl.type === 'wait' && rl.until, NOW + RATE_LIMIT_WAIT_MS)
  assert.equal(planQuotaResume({ ...base, settings }).type, 'none')
  const far = planQuotaResume({ ...base, settings, detail: 'try again in 30 days' })
  assert.equal(far.type === 'none' && far.why, 'far')
  // 同一条输入之后最多自动接几次
  const state = { input: 'u1', n: QUOTA_AUTO_MAX, tried: [] }
  const r = planQuotaResume({ ...base, settings, kind: 'rate_limit', state })
  assert.equal(r.type === 'none' && r.why, 'max')
})

test('状态窗口：在等额度恢复时写出几点继续，按钮是现在继续', () => {
  const n = lifeNext({ kind: 'conversation', state: 'failed', mode: 'chat', quotaUntil: NOW + 3600_000 } as never, NOW)
  assert.match(n!.text, /自动继续/)
  assert.equal(n!.action?.kind, 'resume')
})
