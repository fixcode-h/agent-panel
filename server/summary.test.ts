import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import type { SummaryConfig, SummaryJob, SummaryRecord as ReportRecord, SummaryReport } from '../shared/summary.ts'
import type { Agent } from '../shared/schema.ts'

// 数据目录换成临时的，别动本机的报告
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-summary-'))
process.env.AGENT_PANEL_DATA = dir

const { createCollection } = await import('./store.ts')
const { summaryApi, summaryRoleText } = await import('./summary.ts')
const { SummaryRecord, summaryRole } = await import('../shared/summary.ts')
const { BUILTIN_AGENTS } = await import('../shared/builtin/agents.ts')
// 语言在 server/lang.ts 里按 process.env.LANG 定（CI 是英文），断言用同一个 t() 算期望值
const { t } = await import('../shared/i18n.ts')

const reports = createCollection<SummaryReport, ReportRecord>('summaries.json', SummaryRecord)
let config: SummaryConfig = { projectIds: [] }
const app = new Hono()
app.route(
  '/summary',
  summaryApi({
    tasks: { list: async () => [], get: async () => null },
    projects: { list: async () => [{ id: 'p1', name: '面板', path: '' }] as never },
    agents: { list: async () => [] },
    reports,
    config: { get: async () => config, set: async (c) => void (config = c) },
  }).routes,
)

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

const item = (over: object = {}) => ({
  id: 'i1',
  kind: 'need',
  project: '面板',
  title: '支持按周生成',
  content: '可以选一周，从日报汇总成周报',
  ...over,
})

test('列表与面板里的项目：没有报告时是空数组；项目保存后读回来，重复的去掉', async () => {
  const res = await app.request('/summary')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { reports: [] })
  const put = await app.request('/summary/config', json('PUT', { projectIds: ['p1', 'p2', 'p1'] }))
  assert.equal(put.status, 200)
  assert.deepEqual(await (await app.request('/summary/config')).json(), { projectIds: ['p1', 'p2'] })
  const bad = await app.request('/summary/config', json('PUT', { projectIds: [''] }))
  assert.equal(bad.status, 400)
})

test('提炼：对话来源没加项目直接报错，不启动', async () => {
  const res = await app.request('/summary/extract', json('POST', { source: 'tasks', grain: 'day', day: '2026-10-23' }))
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: string }).error, t('先添加要总结的项目'))
  const bad = await app.request('/summary/extract', json('POST', { source: 'tasks', grain: 'month', day: 'x' }))
  assert.equal(bad.status, 400)
  // 查一次不存在的提炼：404
  assert.equal((await app.request('/summary/jobs/nope')).status, 404)
})

test('提炼：这段时间没有材料时不跑 CLI，直接给空分项', async () => {
  const res = await app.request(
    '/summary/extract',
    json('POST', { source: 'reports', grain: 'week', day: '2020-01-08', projectIds: [] }),
  )
  // CLI 在这台机器上被停用时也会被拦下：那是另一条路径，这里只关心有没有起任务
  if (res.status !== 201) return
  const job = (await res.json()) as SummaryJob
  assert.equal(job.from, '2020-01-06', '按周从周一开始')
  assert.equal(job.to, '2020-01-12')
  let cur = job
  for (let i = 0; i < 50 && cur.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    cur = (await (await app.request(`/summary/jobs/${job.id}`)).json()) as SummaryJob
  }
  assert.equal(cur.status, 'done')
  assert.deepEqual(cur.items, [])
  assert.equal(cur.reportCount, 0)
})

test('确认生成：只用传进来的分项拼报告，存下分项和元数据', async () => {
  const res = await app.request(
    '/summary',
    json('POST', {
      source: 'tasks',
      grain: 'day',
      from: '2026-10-23',
      to: '2026-10-23',
      projectIds: ['p1'],
      projectNames: ['面板'],
      items: [
        item(),
        item({ id: 'i2', kind: 'bug', title: '点暂停显示已停止', cause: '状态没同步', fix: '退出时同步状态' }),
      ],
      cli: 'pi',
      taskCount: 3,
      durationMs: 1200,
    }),
  )
  assert.equal(res.status, 201)
  const rec = (await res.json()) as ReportRecord
  assert.equal(rec.day, '2026-10-23')
  assert.equal(rec.items.length, 2)
  assert.match(rec.md, /^# 2026-10-23 工作总结\n/)
  assert.match(rec.md, /## 一、需求[\s\S]*支持按周生成[\s\S]*## 二、Bug[\s\S]*原因：状态没同步/)
  // 一条都没采纳不能生成
  const empty = await app.request(
    '/summary',
    json('POST', { source: 'tasks', grain: 'day', from: '2026-10-23', to: '2026-10-23', items: [] }),
  )
  assert.equal(empty.status, 400)
  // 老报告：没有新字段时按默认值读（对话来源、没有分项、耗时 0）
  const old = SummaryRecord.parse({ id: 'old', createdAt: '', updatedAt: '', day: '2026-10-20', md: '# x' })
  assert.equal(old.source, 'tasks')
  assert.deepEqual(old.items, [])
  assert.equal(old.durationMs, 0)
  assert.equal(old.grain, undefined)
})

test('编辑与删除：保存改过的 Markdown，删除后列表里没有，再删 404', async () => {
  const [rec] = (await reports.list()).slice(-1)
  const put = await app.request(`/summary/${rec.id}`, json('PUT', { md: '# 改过\n' }))
  assert.equal(put.status, 200)
  assert.equal(((await put.json()) as ReportRecord).md, '# 改过\n')
  assert.equal((await app.request('/summary/nope', json('PUT', { md: 'x' }))).status, 404)
  assert.equal((await app.request(`/summary/${rec.id}`, { method: 'DELETE' })).status, 200)
  const list = (await (await app.request('/summary')).json()) as { reports: ReportRecord[] }
  assert.ok(!list.reports.some((r) => r.id === rec.id))
  assert.equal((await app.request(`/summary/${rec.id}`, { method: 'DELETE' })).status, 404)
})

test('生成用的角色：优先用本机的「每日工作总结」，被删了用内置定义；设定里只取面板提供材料那一段', () => {
  const def = BUILTIN_AGENTS.find((b) => b.key === 'worklog')!
  const mine = { ...def.agent, id: 'mine', origin: 'builtin:worklog', model: '@high' } as Agent
  assert.equal(summaryRole([mine]).id, 'mine')
  assert.equal(summaryRole([]).name, '每日工作总结')
  const text = summaryRoleText(summaryRole([]))
  assert.match(text, /材料和范围由面板在下面给出/)
  assert.doesNotMatch(text, /tasks\/projects\//, '面板给了材料就不再让它去读数据目录')
  assert.doesNotMatch(text, /\{\{/)
})
