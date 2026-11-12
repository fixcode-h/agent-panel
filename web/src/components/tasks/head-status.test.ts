/**
 * 页签条右端胶囊的显示口径：运行中、等结果都只显示累计执行时长，等什么放进提示。
 * 以前运行中按最后一条用户消息计时（长会话发一句就变回 0:xx），等子对话时时间被「子对话执行中」顶掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '@shared/i18n'
import { taskLiveOf, type LiveRuntime } from '@shared/task-live'
import { clock, headStatus as headView, type HeadStatusTask } from './head-status'

// 断言的是中文文案：固定语言，不跟着 CI 的 LANG 变（见 docs/lessons 的测试教训）
setLang('zh')

const NOW = Date.parse('2026-11-02T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const task = (over: Partial<HeadStatusTask> = {}): HeadStatusTask => ({
  status: 'running',
  steps: [],
  working: false,
  runMs: 0,
  runStartedAt: '',
  createdAt: ago(2 * 60 * 60_000),
  updatedAt: ago(0),
  ...over,
})

/** 状态由服务端算好放在 live 里：测试里按同一个 taskLiveOf 算 */
const headStatus = (tk: HeadStatusTask, now: number, rt: Partial<LiveRuntime> = {}) =>
  headView(
    tk,
    taskLiveOf(tk, { cliAlive: false, jobs: [], childrenWorking: 0, childrenCli: 0, childrenNeeds: 0, ...rt }),
    now,
  )

test('等子对话时只显示累计执行时长，在等什么放进提示', () => {
  const view = headStatus(task({ runMs: 18 * 60_000 + 26_000 }), NOW, { childrenWorking: 1 })
  assert.equal(view?.text, '18:26')
  assert.equal(view?.hint, '子对话执行中 · 18:26')
  assert.equal(view?.tone, 'run')
  assert.equal(view?.spin, true)
})

test('运行中按累计时长走：已完成的段加上正在跑的这段，不从最后一条用户消息重算', () => {
  const view = headStatus(task({ working: true, runMs: 16 * 60_000, runStartedAt: ago(2 * 60_000) }), NOW)
  assert.equal(view?.text, '18:00')
  assert.equal(view?.hint, '执行中 · 18:00')
})

test('超过一小时写成 1:02:05', () => {
  const view = headStatus(task({ runMs: (3600 + 125) * 1000 }), NOW, { childrenWorking: 1 })
  assert.equal(view?.text, '1:02:05')
})

test('等你处理保留琥珀提示，时长放进提示', () => {
  const view = headStatus(task({ runMs: 3 * 60_000 }), NOW, { childrenNeeds: 1 })
  assert.equal(view?.text, '子对话等你处理')
  assert.equal(view?.hint, '子对话等你处理 · 3:00')
  assert.equal(view?.tone, 'wait')
  assert.equal(view?.spin, false)
})

test('没在跑、没在等时不出胶囊', () => {
  assert.equal(headStatus(task({ status: 'done' }), NOW), null)
})

test('时长写成紧凑的时钟样式，负数按 0', () => {
  assert.equal(clock(0), '0:00')
  assert.equal(clock(3 * 60_000 + 12_000), '3:12')
  assert.equal(clock(-1000), '0:00')
  assert.equal(clock((3600 + 2 * 60 + 5) * 1000), '1:02:05')
})
