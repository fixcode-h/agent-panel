/**
 * 「状态」窗口最上面那一句（分析稿 U11）：在等谁、等了多久、下一步按钮。
 * 以前只写「这一轮已说完」「在等你处理：确认操作或回答提问」，第一眼看不出该怎么办。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import { lifeNext, lifeWordFacts, waitedFor } from './life-next.ts'
import type { LifeFacts } from './lifecycle.ts'
import { Task } from './schema.ts'

setLang('zh')
const AT = '2026-11-10T08:00:00.000Z'
const NOW = Date.parse(AT) + 12 * 60_000

const task = (extra: Record<string, unknown> = {}) =>
  Task.parse({
    id: 't',
    projectId: 'p',
    title: 't',
    mode: 'chat',
    status: 'running',
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  })

/** 服务端收集的对话事实：判定只用到这几项，其余给默认值 */
const facts = (tk: Task, over: Partial<LifeFacts> = {}): LifeFacts => ({
  kind: 'conversation',
  status: tk.status,
  stopReason: tk.stopReason,
  working: !!tk.working,
  awaitingUser: false,
  held: 0,
  cliAlive: false,
  helpers: 0,
  jobs: 0,
  waitsOn: [],
  ...lifeWordFacts(tk),
  ...over,
})

test('等你回答：写出等了多久，按钮是「去回答」', () => {
  const tk = task({ parentAsks: [{ id: 'q', question: '选哪个？', options: ['A'] }], turnDoneAt: AT })
  const next = lifeNext(facts(tk, { state: 'needs' }), NOW)
  assert.equal(next?.text, '等你回答 · 已等 12 分钟')
  assert.deepEqual(next?.action, { kind: 'go', label: '去回答' })
})

test('等你确认命令：从请求发出算起', () => {
  const tk = task({
    requests: [{ id: 'r', kind: 'command', title: '运行命令', at: AT }],
    waitStartedAt: new Date(NOW - 90_000).toISOString(),
  })
  const next = lifeNext(facts(tk, { state: 'needs' }), NOW)
  assert.equal(next?.text, '等你确认 · 已等 2 分钟')
  assert.equal(next?.action?.label, '去确认')
})

test('失败：给「重试」，Chat 对话再给「换个模型重试」，工作流不给', () => {
  const tk = task({ status: 'failed', updatedAt: new Date(NOW - 3 * 60_000).toISOString() })
  const next = lifeNext(facts(tk, { state: 'failed' }), NOW)
  assert.equal(next?.text, '这一轮失败了 · 3 分钟前')
  assert.equal(next?.action?.kind, 'resume')
  assert.equal(next?.retryModel, true)
  const flow = task({ status: 'failed', mode: 'workflow' })
  assert.equal(lifeNext(facts(flow, { state: 'failed' }), NOW)?.retryModel, false)
})

test('中断：写清是谁停的，按钮是「继续」', () => {
  const tk = task({ status: 'stopped', stopReason: 'user' })
  const next = lifeNext(facts(tk, { state: 'stopped' }), NOW)
  assert.match(next?.text ?? '', /^已中断：/)
  assert.deepEqual(next?.action, { kind: 'resume', label: '继续' })
})

test('等子对话：说出在等哪一个，按钮在树上选中它', () => {
  const tk = task({ childrenWorking: 1, turnDoneAt: new Date(NOW - 5 * 60_000).toISOString() })
  const f = facts(tk, { state: 'waiting', waitsOn: [{ id: 'kid', title: '修购物车角标', state: 'running' }] })
  const next = lifeNext(f, NOW)
  assert.equal(next?.text, '在等子对话「修购物车角标」 · 已等 5 分钟')
  assert.deepEqual(next?.action, { kind: 'pick', label: '查看', node: 'kid' })
})

test('答完了：不再只写「这一轮已说完」，说清在等你的下一句', () => {
  const tk = task({ status: 'done', turnDoneAt: new Date(NOW - 30_000).toISOString() })
  const next = lifeNext(facts(tk, { state: 'done' }), NOW)
  assert.equal(next?.text, '这一轮答完了，在等你的下一句 · 已等 30 秒')
  assert.equal(next?.action?.label, '去回复')
})

test('执行中在等模型：写出这次请求等了多久；子任务没有这一句', () => {
  const tk = task({ working: true })
  const f = facts(tk, { state: 'running', working: true, trace: { requests: 3, requestAt: NOW - 54_000 } })
  assert.equal(lifeNext(f, NOW)?.text, '在等模型回复 · 已等 54 秒')
  assert.equal(lifeNext({ ...f, kind: 'helper' }, NOW), undefined)
})

test('等了多久只到分钟，超过一小时写小时', () => {
  assert.equal(waitedFor(0), '0 秒')
  assert.equal(waitedFor(59_000), '59 秒')
  assert.equal(waitedFor(61 * 60_000), '1 小时 1 分钟')
})
