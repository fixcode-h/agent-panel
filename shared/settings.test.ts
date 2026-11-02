import assert from 'node:assert/strict'
import test from 'node:test'
import { Settings } from './schema.ts'
import { migrateRemovedClis } from './settings.ts'

test('旧设置里的 keepAliveLimit / unreadGraceMinutes 读时剥离：两项设置已取消，不会报错', () => {
  // 用户 2026-11-02 决定取消保活数量上限和未读回复的独立保留时长：
  // 旧 settings.json 里的字段直接丢弃，不触发整份设置重置
  assert.equal(Settings.safeParse({ keepAliveLimit: 1, unreadGraceMinutes: 5 }).success, true)
  const s = Settings.parse({ keepAliveLimit: 4, unreadGraceMinutes: 5, presenceGraceMinutes: 5 })
  assert.equal('keepAliveLimit' in s, false, '读出来的设置里不再有 keepAliveLimit')
  assert.equal('unreadGraceMinutes' in s, false, '读出来的设置里不再有 unreadGraceMinutes')
  assert.equal(s.presenceGraceMinutes, 5, '同一份设置里的其他项照常读出')
})

test('旧设置里的 Gemini API 和 Gemini CLI 在读出来之前清掉，幂等', () => {
  const raw = {
    apis: [
      { id: 'g1', name: 'Gemini', protocol: 'gemini', models: ['gemini-3-pro'] },
      { id: 'c1', name: 'Relay', protocol: 'openai-chat', baseUrl: 'https://x.example/v1', models: ['m'] },
    ],
    clis: {
      gemini: { enabled: true },
      commandcode: { authMode: 'api', apiId: 'g1' },
      pi: { authMode: 'account' },
    },
  }
  assert.equal(migrateRemovedClis(raw), true)
  assert.deepEqual(
    raw.apis.map((a) => a.id),
    ['c1'],
  )
  assert.equal('gemini' in raw.clis, false)
  // 指向被去掉的 API 的「API 方式」回退到账号方式，不然设置页会有一个选不中的 API
  assert.deepEqual(raw.clis.commandcode, { authMode: 'account', apiId: '' })
  assert.deepEqual(raw.clis.pi, { authMode: 'account' })

  // 协议枚举里已经没有 gemini：清完必须能按现在的结构读出来，否则整份设置会被当成损坏文件重置
  const s = Settings.parse(raw)
  assert.deepEqual(
    s.apis.map((a) => a.id),
    ['c1'],
  )
  assert.equal(s.clis.gemini, undefined)
  assert.equal(s.clis.commandcode.authMode, 'account')

  // 幂等：再跑一次没有改动；没有要清的条目和不是对象时也原样返回
  const before = structuredClone(raw)
  assert.equal(migrateRemovedClis(raw), false)
  migrateRemovedClis(raw)
  assert.deepEqual(raw, before)
  assert.equal(migrateRemovedClis(null), false)
  assert.equal(migrateRemovedClis('x'), false)
})
