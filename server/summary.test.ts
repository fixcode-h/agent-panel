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
  // 老报告只有 day：from / to 为空时按单日处理（和改造前一样）
  from: '',
  to: '',
  projectIds: ['p1'],
  projectNames: ['面板'],
  md: '# 2026-10-23 工作总结\n\n## 一、需求进度\n\n### 1.1 面板\n1. **修好登录报错** ｜ 已完成\n   实现：刷新 token 后再试\n',
  cli: 'pi',
  model: '',
  effort: '',
  taskCount: 1,
  durationMs: 0,
})

test('列表：没有报告时是空数组', async () => {
  const res = await app.request('/summary')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { reports: [] })
})

test('生成：项目没选、CLI 不认识都直接报错，不启动', async () => {
  const empty = await app.request('/summary', json('POST', { projects: [], cli: 'pi' }))
  assert.equal(empty.status, 400)
  // 请求是「项目 → 对话 id列表」两层：没选对话（taskIds 缺省）也算合法请求，只有 CLI 不认识才拦下
  const unknown = await app.request('/summary', json('POST', { projects: [{ projectId: 'p1' }], cli: '没有这个 CLI' }))
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
  const res = await app.request(
    `/summary/${created.id}`,
    json('PUT', { md: '# 2026-10-23 工作总结\n\n## 三、今日小结\n改过的内容\n' }),
  )
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

test('报告记录：耗时按数值保存，老报告没有这个字段时按 0 处理', async () => {
  // 老报告（没有 durationMs 字段）读进 schema 时补 0，页面据此不显示耗时
  const legacy: Record<string, unknown> = { ...sample(), id: 'old', createdAt: '', updatedAt: '' }
  delete legacy.durationMs
  assert.equal(SummaryRecord.parse(legacy).durationMs, 0)
  const timed = await reports.create({ ...sample(), durationMs: 12_500 })
  // 新字段读回来还在
  const list = (await (await app.request('/summary')).json()) as { reports: (SummaryReport & { id: string })[] }
  assert.equal(list.reports.find((r) => r.id === timed.id)?.durationMs, 12_500)
})
