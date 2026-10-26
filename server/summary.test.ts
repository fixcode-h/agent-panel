import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Hono } from 'hono'
import type { SummaryRecord as ReportRecord, SummaryReport } from '../shared/summary.ts'

// 数据目录换成临时的，别动本机的报告
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-summary-'))
process.env.AGENT_PANEL_DATA = dir

const { createCollection } = await import('./store.ts')
const { summaryApi } = await import('./summary.ts')
const { SummaryRecord } = await import('../shared/summary.ts')
// 语言在 server/lang.ts 里按 process.env.LANG 定（CI 是英文），断言用同一个 t() 算期望值
const { t } = await import('../shared/i18n.ts')

const reports = createCollection<SummaryReport, ReportRecord>('summaries.json', SummaryRecord)
const app = new Hono()
app.route(
  '/summary',
  summaryApi({
    tasks: { list: async () => [], get: async () => null },
    projects: { list: async () => [] },
    reports,
  }).routes,
)

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

const sample = (): SummaryReport => ({
  day: '2026-10-23',
  projectIds: ['p1'],
  projectNames: ['面板'],
  md: '## 面板\n- **做了**：修好登录报错\n',
  cli: 'pi',
  model: '',
  effort: '',
  taskCount: 1,
})

test('列表：没有报告时是空数组', async () => {
  const res = await app.request('/summary')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { reports: [] })
})

test('生成：项目没选、CLI 不认识都直接报错，不启动', async () => {
  const empty = await app.request('/summary', json('POST', { projectIds: [], cli: 'pi' }))
  assert.equal(empty.status, 400)
  const unknown = await app.request('/summary', json('POST', { projectIds: ['p1'], cli: '没有这个 CLI' }))
  assert.equal(unknown.status, 400)
  // 期望值用同一个 t() 生成：写死中文在本机过、英文环境挂（见 docs/lessons/testing.md）
  assert.equal(((await unknown.json()) as { error: string }).error, t('未知的 Agent：{cli}', { cli: '没有这个 CLI' }))
})

test('查一次不存在的生成：404', async () => {
  const res = await app.request('/summary/jobs/nope')
  assert.equal(res.status, 404)
})

test('编辑：保存改过的 Markdown，列表里能读回来', async () => {
  const created = await reports.create(sample())
  const res = await app.request(`/summary/${created.id}`, json('PUT', { md: '## 面板\n- **做了**：改过的内容\n' }))
  assert.equal(res.status, 200)
  const saved = (await res.json()) as SummaryReport & { id: string }
  assert.equal(saved.id, created.id)
  assert.match(saved.md, /改过的内容/)

  const list = (await (await app.request('/summary')).json()) as { reports: (SummaryReport & { id: string })[] }
  assert.equal(list.reports.length, 1)
  assert.equal(list.reports[0].id, created.id)
  assert.match(list.reports[0].md, /改过的内容/)
})

test('编辑：报告不存在时 404', async () => {
  const res = await app.request('/summary/nope', json('PUT', { md: 'x' }))
  assert.equal(res.status, 404)
})
