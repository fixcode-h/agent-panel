import { Hono, type Context } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { z } from 'zod'
import {
  Agent,
  AgentInput,
  Category,
  CategoryInput,
  Project,
  ProjectCategory,
  ProjectCategoryInput,
  ProjectInput,
  Workflow,
  WorkflowInput,
} from '../shared/schema.ts'
import { getCli } from '../shared/clis.ts'
import { migrateDocSteps } from '../shared/flow.ts'
import { createCollection } from './store.ts'
import { tasksApi } from './tasks.ts'
import { assistApi } from './assist.ts'
import { detectClis, invalidateClis } from './detect.ts'
import { getSettings, saveSettings } from './settings.ts'
import { Settings } from '../shared/schema.ts'
import { inspectDir, listDir, resolvePath } from './fs.ts'

const agents = createCollection<AgentInput, Agent>('agents.json', Agent)
const categories = createCollection<CategoryInput, Category>('categories.json', Category)
const workflows = createCollection<WorkflowInput, Workflow>('workflows.json', Workflow)
const projectCategories = createCollection<ProjectCategoryInput, ProjectCategory>(
  'project-categories.json',
  ProjectCategory,
)
const projects = createCollection<ProjectInput, Project>('projects.json', Project)

// 旧版工作流把步骤写在文档的二级标题里，启动时迁移成流程图
for (const w of await workflows.list()) {
  if (w.stages.length || !/^##\s/m.test(w.document)) continue
  const m = migrateDocSteps(w, await agents.list())
  if (m.stages.length) {
    const { id, createdAt, updatedAt, ...input } = w
    await workflows.update(id, { ...input, ...m })
  }
}

const app = new Hono().basePath('/api')

const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)

async function parseAgent(body: unknown) {
  const p = AgentInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if (!getCli(p.data.cli)) return { error: `未知的 CLI：${p.data.cli}` }
  if (p.data.categoryId && !(await categories.get(p.data.categoryId))) return { error: '分类不存在' }
  return { data: p.data }
}

async function parseWorkflow(body: unknown) {
  const p = WorkflowInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const wf = p.data
  const ids = new Set((await agents.list()).map((a) => a.id))
  if (wf.mainAgentId && !ids.has(wf.mainAgentId)) return { error: '主 Agent 不存在' }
  // 去掉不存在的、重复的成员，以及和主 Agent 相同的成员
  const seen = new Set<string>([wf.mainAgentId])
  wf.members = wf.members.filter((m) => ids.has(m.agentId) && !seen.has(m.agentId) && seen.add(m.agentId))
  return { data: wf }
}

app.get('/health', (c) => c.json({ ok: true }))
// ---- 设置 ----
app.get('/settings', async (c) => c.json(await getSettings()))
app.put('/settings', async (c) => {
  const p = Settings.safeParse(await c.req.json())
  if (!p.success) return bad(c, z.prettifyError(p.error))
  for (const id of Object.keys(p.data.clis)) if (!getCli(id)) delete p.data.clis[id]
  invalidateClis()
  return c.json(await saveSettings(p.data))
})

app.get('/clis', async (c) => c.json(await detectClis(c.req.query('refresh') === '1')))

// ---- 分类 ----
app.get('/categories', async (c) => c.json(await categories.list()))

async function parseCategory(body: unknown, selfId?: string) {
  const p = CategoryInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const dup = (await categories.list()).some((x) => x.name === p.data.name && x.id !== selfId)
  return dup ? { error: `分类「${p.data.name}」已存在` } : { data: p.data }
}

app.post('/categories', async (c) => {
  const r = await parseCategory(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await categories.create(r.data!), 201)
})

app.put('/categories/:id', async (c) => {
  const id = c.req.param('id')
  const r = await parseCategory(await c.req.json(), id)
  if (r.error) return bad(c, r.error)
  const x = await categories.update(id, r.data!)
  return x ? c.json(x) : bad(c, '分类不存在', 404)
})

// 删除分类时，其中的 Agent 变为未分类
app.delete('/categories/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await categories.remove(id))) return bad(c, '分类不存在', 404)
  for (const a of await agents.list()) {
    if (a.categoryId === id) await agents.update(a.id, { ...a, categoryId: '' })
  }
  return c.body(null, 204)
})

// ---- Agent ----
app.get('/agents', async (c) => c.json(await agents.list()))

app.post('/agents', async (c) => {
  const r = await parseAgent(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await agents.create(r.data!), 201)
})

app.put('/agents/:id', async (c) => {
  const r = await parseAgent(await c.req.json())
  if (r.error) return bad(c, r.error)
  const a = await agents.update(c.req.param('id'), r.data!)
  return a ? c.json(a) : bad(c, 'Agent 不存在', 404)
})

app.delete('/agents/:id', async (c) => {
  const id = c.req.param('id')
  const used = (await workflows.list()).filter((w) => w.mainAgentId === id || w.members.some((m) => m.agentId === id))
  if (used.length)
    return bad(c, `正在被工作流使用：${used.map((w) => `「${w.name}」`).join('、')}，请先从工作流中移除`, 409)
  return (await agents.remove(id)) ? c.body(null, 204) : bad(c, 'Agent 不存在', 404)
})

// ---- 工作流 ----
app.get('/workflows', async (c) => c.json(await workflows.list()))

app.post('/workflows', async (c) => {
  const r = await parseWorkflow(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await workflows.create(r.data!), 201)
})

app.put('/workflows/:id', async (c) => {
  const r = await parseWorkflow(await c.req.json())
  if (r.error) return bad(c, r.error)
  const w = await workflows.update(c.req.param('id'), r.data!)
  return w ? c.json(w) : bad(c, '工作流不存在', 404)
})

app.delete('/workflows/:id', async (c) => {
  const id = c.req.param('id')
  const users = [
    ...(await projectCategories.list()).filter((x) => x.workflowId === id).map((x) => `项目分类「${x.name}」`),
    ...(await projects.list()).filter((x) => x.workflowId === id).map((x) => `项目「${x.name}」`),
  ]
  if (users.length) return bad(c, `正在被使用：${users.join('、')}，请先改用其他工作流`, 409)
  return (await workflows.remove(id)) ? c.body(null, 204) : bad(c, '工作流不存在', 404)
})

// ---- 项目分类 ----
async function parseProjectCategory(body: unknown, selfId?: string) {
  const p = ProjectCategoryInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if ((await projectCategories.list()).some((x) => x.name === p.data.name && x.id !== selfId))
    return { error: `分类「${p.data.name}」已存在` }
  if (p.data.workflowId && !(await workflows.get(p.data.workflowId))) return { error: '工作流不存在' }
  return { data: p.data }
}

app.get('/project-categories', async (c) => c.json(await projectCategories.list()))

app.post('/project-categories', async (c) => {
  const r = await parseProjectCategory(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await projectCategories.create(r.data!), 201)
})

app.put('/project-categories/:id', async (c) => {
  const id = c.req.param('id')
  const r = await parseProjectCategory(await c.req.json(), id)
  if (r.error) return bad(c, r.error)
  const x = await projectCategories.update(id, r.data!)
  return x ? c.json(x) : bad(c, '分类不存在', 404)
})

// 删除分类时，其中的项目变为未分类
app.delete('/project-categories/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await projectCategories.remove(id))) return bad(c, '分类不存在', 404)
  for (const p of await projects.list()) {
    if (p.categoryId === id) await projects.update(p.id, { ...p, categoryId: '' })
  }
  return c.body(null, 204)
})

// ---- 项目 ----
async function parseProject(body: unknown) {
  const p = ProjectInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if (p.data.categoryId && !(await projectCategories.get(p.data.categoryId))) return { error: '项目分类不存在' }
  if (p.data.workflowId && !(await workflows.get(p.data.workflowId))) return { error: '工作流不存在' }
  if (p.data.path) p.data.path = resolvePath(p.data.path)
  return { data: p.data }
}

app.get('/projects', async (c) => c.json(await projects.list()))

app.post('/projects', async (c) => {
  const r = await parseProject(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await projects.create(r.data!), 201)
})

app.put('/projects/:id', async (c) => {
  const r = await parseProject(await c.req.json())
  if (r.error) return bad(c, r.error)
  const x = await projects.update(c.req.param('id'), r.data!)
  return x ? c.json(x) : bad(c, '项目不存在', 404)
})

app.delete('/projects/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await projects.remove(id))) return bad(c, '项目不存在', 404)
  await tasks.removeByProject(id)
  return c.body(null, 204)
})

// ---- 任务 ----
const tasks = tasksApi({ agents, workflows, projects, projectCategories })
app.route('/tasks', tasks.routes)
app.route('/assist', assistApi({ agents, categories, workflows }))

// ---- 本地目录 ----
app.get('/fs/inspect', async (c) => c.json(await inspectDir(c.req.query('path') ?? '')))

app.get('/fs/list', async (c) => {
  try {
    return c.json(await listDir(c.req.query('path') ?? ''))
  } catch (e) {
    return bad(c, `无法读取目录：${(e as Error).message}`)
  }
})

const root = new Hono()
root.route('/', app)
// 生产模式下直接托管前端构建产物
if (process.env.NODE_ENV === 'production' || process.argv.includes('--prod')) {
  root.use('/*', serveStatic({ root: './dist' }))
  root.get('*', serveStatic({ path: './dist/index.html' }))
}

const port = Number(process.env.PORT ?? 8787)
// 只监听本机：这个服务之后会启动本地 CLI，不应暴露到局域网
serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Agent 面板服务已启动: http://127.0.0.1:${port}`)
})
