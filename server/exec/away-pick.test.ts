/**
 * 「我不在」开着时 CLI 的提问：能选的当场按推荐选掉（对话留一行、记进总览、答案交回 CLI），
 * 已经挂着的在打开时一起选掉；关着或拿不准时照旧等用户。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-away-'))
process.env.AGENT_PANEL_DATA = dir

const { setLang } = await import('../../shared/i18n.ts')
const { awayApi, awayState } = await import('../away.ts')
const { autoAllowed } = await import('./ask-request.ts')
const { awayPickPending } = await import('./away-pick.ts')
const { replies } = await import('./panel-requests.ts')
const { AskQuestion } = await import('../../shared/tasks/request.ts')
type Task = import('../../shared/schema.ts').Task

setLang('zh')

const app = awayApi()
const turn = (on: boolean) =>
  app.request('/', { method: 'PUT', body: JSON.stringify({ on }), headers: { 'content-type': 'application/json' } })

const questions = (over: Record<string, unknown>) => [
  AskQuestion.parse({ question: '先做哪一步？', options: [{ label: '先改接口' }, { label: '先写测试' }], ...over }),
]
const newTask = () =>
  ({ id: 't1', projectId: 'p1', title: '加缓存', messages: [], requests: [], allowRules: [] }) as unknown as Task
const ask = (over: Record<string, unknown>) => {
  const got: any[] = []
  return {
    got,
    ev: {
      type: 'ask',
      kind: 'question',
      title: 'x',
      detail: '',
      questions: questions(over),
      reply: (r: any) => got.push(r),
    } as any,
  }
}
const meta = { id: 'm1', step: '', agentId: 'a' }

test('关着：能选的提问也照旧等用户', async () => {
  await turn(false)
  const task = newTask()
  const a = ask({ reversible: true, recommended: 1 })
  assert.equal(autoAllowed(task, a.ev, meta), false)
  assert.equal(a.got.length, 0)
})

test('开着：按推荐选掉，对话留一行、答案交回 CLI、记进数据目录', async () => {
  await turn(true)
  const task = newTask()
  const a = ask({ reversible: true, recommended: 1 })
  assert.equal(autoAllowed(task, a.ev, meta), true)
  assert.deepEqual(a.got, [{ allow: true, answer: '先写测试', answers: ['先写测试'] }])
  const m = task.messages.at(-1)!
  assert.match(m.text, /你不在，面板按 Agent 推荐的选项替你选了「先写测试」/)
  assert.deepEqual(m.answers, [{ question: '先做哪一步？', answer: '先写测试' }])
  assert.equal(awayState().picks[0].taskId, 't1')
  assert.equal(awayState().picks[0].items[0].picked, '先写测试')
  // 写文件是排队的：等到写进这一条再读。以前固定等 50ms，CI 并发跑时还没落盘，picks 为空（抖动）
  const read = () => {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'config', 'away.json'), 'utf8'))
    } catch {
      return {}
    }
  }
  const end = Date.now() + 5000
  while (!read().picks?.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  const saved = read()
  assert.equal(saved.on, true)
  assert.equal(saved.picks[0].id, 'm1')
})

test('开着但拿不准（没标能反悔）：照旧等用户', async () => {
  await turn(true)
  const task = newTask()
  const a = ask({ recommended: 0 })
  assert.equal(autoAllowed(task, a.ev, meta), false)
  assert.equal(a.got.length, 0)
})

test('打开时已经挂着的提问：能选的选掉并收起，拿不准的留着', () => {
  const task = newTask()
  const got: any[] = []
  const req = (id: string, over: Record<string, unknown>) => ({
    id,
    step: '',
    agentId: '',
    kind: 'question' as const,
    title: '先做哪一步？',
    detail: '',
    options: [],
    questions: questions(over),
    at: '',
  })
  task.requests = [req('r1', { reversible: true, recommended: 0 }), req('r2', {})]
  replies.set('r1', (r) => got.push(['r1', r]))
  replies.set('r2', (r) => got.push(['r2', r]))
  assert.equal(awayPickPending(task), 1)
  assert.deepEqual(got, [['r1', { allow: true, answer: '先改接口', answers: ['先改接口'] }]])
  assert.deepEqual(
    task.requests.map((x) => x.id),
    ['r2'],
  )
  assert.equal(replies.has('r1'), false)
  assert.equal(replies.has('r2'), true)
})
