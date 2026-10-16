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
import { END, START, findRefCycle, migrateDocSteps } from '../shared/flow.ts'
import { createCollection } from './store.ts'
import { tasksApi } from './tasks.ts'
import { assistApi } from './assist.ts'
import { detectClis, invalidateClis } from './detect.ts'
import { installApi } from './install.ts'
import { openBrowser } from './open.ts'
import { modelsApi } from './models.ts'
import { cleanupOldTray, restartProcess, updateApi } from './update.ts'
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
  if (w.flows.some((f) => f.nodes.length) || !/^##\s/m.test(w.document)) continue
  const m = migrateDocSteps(w, await agents.list())
  if (m) {
    const { id, createdAt, updatedAt, ...input } = w
    await workflows.update(id, {
      ...input,
      flows: [m.flow, ...w.flows.slice(1)],
      entryFlowId: m.flow.id,
      document: m.document,
    })
  }
}

const app = new Hono().basePath('/api')

/**
 * 只接受本机页面的请求。只监听 127.0.0.1 还不够：
 * - DNS 重绑定：恶意网页把自己的域名解析到 127.0.0.1，就能以「同源」身份调用接口 → 检查 Host
 * - 跨站请求：任意网页都能向 127.0.0.1 发 text/plain 的 POST（不触发预检）→ 检查 Origin，写操作必须是 JSON
 * 这些接口能启动本机 CLI、读写目录，被外部网页调用等于远程执行命令。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const hostOf = (h: string) => (h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]).toLowerCase()
app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? ''
  if (!LOCAL_HOSTS.has(hostOf(host))) return c.json({ error: '只接受来自本机的访问' }, 403)
  const origin = c.req.header('origin')
  if (origin !== undefined) {
    let ok = false
    try {
      ok = LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())
    } catch {}
    if (!ok) return c.json({ error: '不接受其他网站发来的请求' }, 403)
  }
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: '不接受其他网站发来的请求' }, 403)
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !/application\/json/i.test(c.req.header('content-type') ?? '')
  )
    return c.json({ error: '请求必须是 JSON' }, 415)
  await next()
})

const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)

async function parseAgent(body: unknown) {
  const p = AgentInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if (p.data.cli && !getCli(p.data.cli)) return { error: `未知的 CLI：${p.data.cli}` }
  if (p.data.categoryId && !(await categories.get(p.data.categoryId))) return { error: '分类不存在' }
  return { data: p.data }
}

async function parseWorkflow(body: unknown, selfId = '') {
  const p = WorkflowInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const wf = p.data
  const ids = new Set((await agents.list()).map((a) => a.id))
  if (wf.mainAgentId && !ids.has(wf.mainAgentId)) return { error: '主 Agent 不存在' }
  // 去掉不存在的、重复的成员，以及和主 Agent 相同的成员
  const seen = new Set<string>([wf.mainAgentId])
  wf.members = wf.members.filter((m) => ids.has(m.agentId) && !seen.has(m.agentId) && seen.add(m.agentId))
  if (!wf.flows.length) return { error: '工作流至少要有一个流程' }
  if (!wf.flows.some((f) => f.id === wf.entryFlowId)) wf.entryFlowId = wf.flows[0].id
  if (new Set(wf.flows.map((f) => f.id)).size !== wf.flows.length) return { error: '流程 id 重复' }
  for (const f of wf.flows) {
    const nodeIds = new Set(f.nodes.map((n) => n.id))
    if (nodeIds.size !== f.nodes.length) return { error: `流程「${f.name}」里有重复的节点 id` }
    if (nodeIds.has(START) || nodeIds.has(END)) return { error: `流程「${f.name}」的节点 id 不能是 start / end` }
    // 节点指定的 Agent 不存在时改由主 Agent 执行
    for (const n of f.nodes) if (n.agentId && !ids.has(n.agentId)) n.agentId = ''
    // 去掉悬空、重复、方向不对的连线
    const keys = new Set<string>()
    f.edges = f.edges.filter((e) => {
      const k = `${e.from}>${e.to}`
      const ok =
        (e.from === START || nodeIds.has(e.from)) &&
        (e.to === END || nodeIds.has(e.to)) &&
        e.from !== e.to &&
        !keys.has(k)
      keys.add(k)
      return ok
    })
    const cyc = cycleIn(f)
    if (cyc) return { error: `流程「${f.name}」里的节点连成了环：${cyc}，执行时会一直等不到上游` }
  }
  const cycle = findRefCycle(
    { ...wf, id: selfId || '__new__', createdAt: '', updatedAt: '' },
    (await workflows.list()).filter((x) => x.id !== selfId),
  )
  if (cycle) return { error: `流程之间循环调用：${cycle.join(' → ')}` }
  return { data: wf }
}

/** 流程图里有没有环；有就返回环上的节点名 */
function cycleIn(f: { nodes: { id: string; title: string }[]; edges: { from: string; to: string }[] }) {
  const state = new Map<string, 1 | 2>()
  const name = (id: string) => f.nodes.find((n) => n.id === id)?.title.trim() || id
  const visit = (id: string, path: string[]): string | null => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id].map(name).join(' → ')
    state.set(id, 1)
    for (const e of f.edges)
      if (e.from === id) {
        const c = visit(e.to, [...path, id])
        if (c) return c
      }
    state.set(id, 2)
    return null
  }
  for (const n of f.nodes) {
    const c = visit(n.id, [])
    if (c) return c
  }
  return null
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
app.route('/clis', installApi())
app.route('/clis', modelsApi())

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
  const used = (await workflows.list()).filter(
    (w) =>
      w.mainAgentId === id ||
      w.members.some((m) => m.agentId === id) ||
      w.flows.some((f) => f.nodes.some((n) => n.agentId === id)),
  )
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
  const r = await parseWorkflow(await c.req.json(), c.req.param('id'))
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

app.route(
  '/app',
  updateApi({
    running: () => tasks.running(),
    // server 在下面才创建，重启时一定已经有了
    restart: () => (process.env.AGENT_PANEL_NO_RESTART ? undefined : restartProcess(() => server.close())),
  }),
)

const root = new Hono()
root.route('/', app)
// 生产模式下直接托管前端构建产物
const prod = process.env.NODE_ENV === 'production' || process.argv.includes('--prod')
if (prod) {
  root.use('/*', serveStatic({ root: './dist' }))
  root.get('*', serveStatic({ path: './dist/index.html' }))
}

const port = Number(process.env.PORT ?? 8787)
// 更新后重启出来的进程：不再打开浏览器（页面已经开着），端口被旧进程占着时重试
const restarted = !!process.env.AGENT_PANEL_RESTARTED
// 由 Windows 托盘程序（AgentPanel.exe）启动
const tray = !!process.env.AGENT_PANEL_TRAY
delete process.env.AGENT_PANEL_RESTARTED
// 只监听本机：这个服务之后会启动本地 CLI，不应暴露到局域网
const server = serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, async () => {
  const url = `http://127.0.0.1:${port}`
  console.log(`Agent 面板服务已启动: ${url}`)
  const open = prod && !restarted && (await getSettings()).openBrowser
  if (tray) {
    // 托盘程序读这两行：显示地址，并由它打开浏览器（服务自己打开会经过 cmd）
    console.log(`AGENT_PANEL_READY ${url}`)
    if (open) console.log(`AGENT_PANEL_OPEN ${url}`)
  } else if (open) openBrowser(url)
})
if (tray) {
  cleanupOldTray()
  // 托盘程序退出时会关掉服务的输入：收尾后退出（还在跑的 CLI 由托盘程序一起结束）
  process.stdin.on('end', () => {
    server.close()
    setTimeout(() => process.exit(0), 300)
  })
  process.stdin.resume()
}
let retries = 0
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && restarted && retries++ < 20) {
    setTimeout(() => server.listen(port, '127.0.0.1'), 500)
    return
  }
  console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可以用环境变量 PORT 换一个端口` : e.message)
  process.exit(1)
})
