// 必须第一个引入：先定下界面语言，其他模块顶层的文案才会用对语言
import './lang.ts'
// 用户自己加的 CLI 配置要在用到 CLI 列表的模块之前读进来
import { CLI_CONFIG_DIR, loadUserClis, userClis } from './cli-config.ts'
import { asksApi } from './asks.ts'
import { Hono, type Context } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  Agent,
  DEFAULT_AGENT_ID,
  defaultAgent,
  AgentInput,
  Category,
  CategoryInput,
  Tag,
  TagInput,
  Project,
  ProjectCategory,
  ProjectCategoryInput,
  ProjectInput,
  Workflow,
  WorkflowInput,
} from '../shared/schema.ts'
import { getCli } from '../shared/clis.ts'
import { migrateDocSteps } from '../shared/flow.ts'
import { extensionSelfReload } from '../shared/design.ts'
import { createCollection, DATA_DIR, migrateDataDir } from './store.ts'
import { seedBuiltinsOnce } from './seed.ts'
import { dataApi } from './data.ts'
import { tasksApi } from './tasks.ts'
import { assistApi } from './assist.ts'
import { designsApi } from './designs.ts'
import { designMcpApi } from './design-mcp.ts'
import { askMcpApi } from './ask-mcp.ts'
import { askExtensionReload, bridgeApi, browserStatus, extensionDir, openExtensionsPage } from './bridge.ts'
import { docsApi } from './docs.ts'
import { detectClis } from './detect.ts'
import { accountsApi } from './accounts.ts'
import { installApi } from './install.ts'
import { comfyApi } from './comfy.ts'
import { libraryApi } from './library.ts'
import { mcpApi } from './mcp-store.ts'
import { openBrowser, revealDir, revealItem } from './open.ts'
import { modelsApi } from './models.ts'
import { getLimits, listSkills } from './cli-extras.ts'
import { appDir, cleanupOldTray, currentVersion, restartProcess, updateApi } from './update.ts'
import { getSettings, saveSettings } from './settings.ts'
import { Settings } from '../shared/schema.ts'
import { inspectDir, listDir, makeDir, resolvePath } from './fs.ts'
import { listCommands } from './slash.ts'
import { searchProjectFiles, uploadsApi, uploadsRawApi } from './uploads.ts'
import { t } from '../shared/i18n.ts'
import { agentDeleteError, checkWorkflow, workflowDeleteError } from '../shared/validate.ts'
import { grantCookie, tokenGuard, withToken } from './auth.ts'
import { installLogging, log, logFile } from './log.ts'

// 更新时旧版本用这个参数试加载新的 server.mjs：模块都能加载就说明这台电脑的 Node 能跑，不动数据、不监听端口
if (process.argv.includes('--self-check')) process.exit(0)
installLogging()

// 先把旧版本的数据搬到用户目录的新结构，后面的集合才读得到
migrateDataDir()

const agents = createCollection<AgentInput, Agent>('agents.json', Agent, () => [defaultAgent()])
const categories = createCollection<CategoryInput, Category>('categories.json', Category)
const tags = createCollection<TagInput, Tag>('tags.json', Tag)
/** 只留存在的标签（标签删掉后，前端还没刷新时可能带着旧 id） */
const knownTags = async (ids: string[]) => {
  const all = new Set((await tags.list()).map((x) => x.id))
  return ids.filter((id) => all.has(id))
}
const workflows = createCollection<WorkflowInput, Workflow>('workflows.json', Workflow)
const projectCategories = createCollection<ProjectCategoryInput, ProjectCategory>(
  'project-categories.json',
  ProjectCategory,
)
const projects = createCollection<ProjectInput, Project>('projects.json', Project)
// 首次启动装上内置工作流和 Agent（之后新增的内置工作流也会补上），在开始接请求之前做完
await seedBuiltinsOnce(
  async () => ({
    agents: await agents.list(),
    categories: await categories.list(),
    tags: await tags.list(),
    workflows: await workflows.list(),
  }),
  {
    createAgent: (a) => agents.create(AgentInput.parse(a)),
    createCategory: (name, scope) => categories.create(CategoryInput.parse({ name, scope })),
    createTag: (x) => tags.create(TagInput.parse(x)),
    createWorkflow: (w) => workflows.create(WorkflowInput.parse(w)),
  },
)

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
  if (!LOCAL_HOSTS.has(hostOf(host))) return c.json({ error: t('只接受来自本机的访问') }, 403)
  const origin = c.req.header('origin')
  // 浏览器扩展只能调 /bridge 下面的接口（报标签页、取指令、交图片），别的一律不行
  if (/^(chrome|moz)-extension:\/\//.test(origin ?? '')) {
    if (!c.req.path.startsWith('/api/bridge/')) return c.json({ error: t('不接受其他网站发来的请求') }, 403)
    return next()
  }
  if (origin !== undefined) {
    let ok = false
    try {
      ok = LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())
    } catch {}
    if (!ok) return c.json({ error: t('不接受其他网站发来的请求') }, 403)
  }
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: t('不接受其他网站发来的请求') }, 403)
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !/application\/json/i.test(c.req.header('content-type') ?? '')
  )
    return c.json({ error: t('请求必须是 JSON') }, 415)
  await next()
})

const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)

async function parseAgent(body: unknown) {
  const p = AgentInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if (p.data.cli && !getCli(p.data.cli)) return { error: t('未知的 CLI：{cli}', { cli: p.data.cli }) }
  if (p.data.categoryId && !(await categories.get(p.data.categoryId))) return { error: t('分类不存在') }
  p.data.tags = await knownTags(p.data.tags)
  return { data: p.data }
}

async function parseWorkflow(body: unknown, selfId = '') {
  const p = WorkflowInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const ids = new Set((await agents.list()).map((a) => a.id))
  const error = checkWorkflow(p.data, ids, await workflows.list(), selfId)
  if (p.data.categoryId && !(await categories.get(p.data.categoryId))) return { error: t('分类不存在') }
  p.data.tags = await knownTags(p.data.tags)
  return error ? { error } : { data: p.data }
}

app.get('/health', (c) => c.json({ ok: true }))
// ---- 设置 ----
app.get('/settings', async (c) => c.json(await getSettings()))
app.put('/settings', async (c) => {
  const p = Settings.safeParse(await c.req.json())
  if (!p.success) return bad(c, z.prettifyError(p.error))
  for (const id of Object.keys(p.data.clis)) if (!getCli(id)) delete p.data.clis[id]
  // 打开访问令牌的是这个浏览器：先给它发 Cookie，免得刚打开就把自己关在外面
  if (p.data.requireToken) grantCookie(c)
  return c.json(await saveSettings(p.data))
})

// 用户在数据目录里加的 CLI 配置：页面拿去注册；改了配置文件后可以重新读
app.get('/clis/specs', (c) => c.json(userClis()))
app.post('/clis/specs/reveal', async (c) => {
  await mkdir(CLI_CONFIG_DIR, { recursive: true })
  revealDir(CLI_CONFIG_DIR)
  return c.json({ ok: true })
})
app.post('/clis/specs/reload', async (c) => {
  loadUserClis()
  await detectClis(true)
  return c.json(userClis())
})
app.get('/clis', async (c) => c.json(await detectClis(c.req.query('refresh') === '1')))
app.route('/accounts', accountsApi())
app.route('/library', libraryApi())
app.route('/mcp-tools', mcpApi())
app.route('/clis', installApi())
app.route('/local-image', comfyApi())
app.route('/clis', modelsApi())
// 账号额度、加载的 Skill；查不到时给出原因，页面上显示
app.get('/clis/:id/limits', async (c) => {
  try {
    return c.json(await getLimits(c.req.param('id')))
  } catch (e) {
    return bad(c, (e as Error).message)
  }
})
app.get('/clis/:id/skills', async (c) => {
  const pid = c.req.query('projectId')
  const dir = pid ? ((await projects.get(pid))?.path ?? '') : ''
  try {
    return c.json(await listSkills(c.req.param('id'), dir))
  } catch (e) {
    return bad(c, (e as Error).message)
  }
})

// 输入框「/」菜单：CLI 自己带的命令和 Skill
app.get('/clis/:id/commands', async (c) => {
  const pid = c.req.query('projectId')
  const dir = pid ? ((await projects.get(pid))?.path ?? '') : ''
  try {
    return c.json(await listCommands(c.req.param('id'), dir))
  } catch (e) {
    return bad(c, (e as Error).message)
  }
})

// ---- 分类 ----
app.get('/categories', async (c) => c.json(await categories.list()))

async function parseCategory(body: unknown, selfId?: string) {
  const p = CategoryInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  // 改名时不带 scope：沿用原来的；Agent 和工作流的分类各自不能重名
  const all = await categories.list()
  const scope = all.find((x) => x.id === selfId)?.scope ?? p.data.scope
  const dup = all.some((x) => x.name === p.data.name && x.scope === scope && x.id !== selfId)
  return dup ? { error: t('分类「{name}」已存在', { name: p.data.name }) } : { data: { ...p.data, scope } }
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
  return x ? c.json(x) : bad(c, t('分类不存在'), 404)
})

// 删除分类时，其中的 Agent 变为未分类
app.delete('/categories/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await categories.remove(id))) return bad(c, t('分类不存在'), 404)
  for (const a of await agents.list()) {
    if (a.categoryId === id) await agents.update(a.id, { ...a, categoryId: '' })
  }
  for (const w of await workflows.list()) {
    if (w.categoryId === id) await workflows.update(w.id, { ...w, categoryId: '' })
  }
  return c.body(null, 204)
})

// ---- 标签：Agent 和工作流共用 ----
app.get('/tags', async (c) => c.json(await tags.list()))

async function parseTag(body: unknown, selfId?: string) {
  const p = TagInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const dup = (await tags.list()).some((x) => x.name === p.data.name && x.id !== selfId)
  return dup ? { error: t('标签「{name}」已存在', { name: p.data.name }) } : { data: p.data }
}

app.post('/tags', async (c) => {
  const r = await parseTag(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await tags.create(r.data!), 201)
})

app.put('/tags/:id', async (c) => {
  const id = c.req.param('id')
  const r = await parseTag(await c.req.json(), id)
  if (r.error) return bad(c, r.error)
  const x = await tags.update(id, r.data!)
  return x ? c.json(x) : bad(c, t('标签不存在'), 404)
})

// 删除标签时从所有 Agent 和工作流上去掉
app.delete('/tags/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await tags.remove(id))) return bad(c, t('标签不存在'), 404)
  for (const a of await agents.list())
    if (a.tags.includes(id)) await agents.update(a.id, { ...a, tags: a.tags.filter((x) => x !== id) })
  for (const w of await workflows.list())
    if (w.tags.includes(id)) await workflows.update(w.id, { ...w, tags: w.tags.filter((x) => x !== id) })
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
  const id = c.req.param('id')
  // 默认 Agent 的 CLI、模型、思考强度固定跟随默认 CLI，只能改名称、角色设定这些
  if (id === DEFAULT_AGENT_ID) Object.assign(r.data!, { cli: '', model: '', effort: '', enabled: true })
  const a = await agents.update(id, r.data!)
  return a ? c.json(a) : bad(c, t('Agent 不存在'), 404)
})

app.delete('/agents/:id', async (c) => {
  const id = c.req.param('id')
  const err = agentDeleteError(id, await workflows.list())
  if (err) return bad(c, err, 409)
  if (!(await agents.remove(id))) return bad(c, t('Agent 不存在'), 404)
  // 引入了它的 Agent 去掉这条引入
  for (const a of await agents.list())
    if (a.includes.includes(id)) await agents.update(a.id, { ...a, includes: a.includes.filter((x) => x !== id) })
  return c.body(null, 204)
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
  return w ? c.json(w) : bad(c, t('工作流不存在'), 404)
})

app.delete('/workflows/:id', async (c) => {
  const id = c.req.param('id')
  const err = workflowDeleteError(id, await projectCategories.list(), await projects.list())
  if (err) return bad(c, err, 409)
  return (await workflows.remove(id)) ? c.body(null, 204) : bad(c, t('工作流不存在'), 404)
})

// ---- 项目分类 ----
async function parseProjectCategory(body: unknown, selfId?: string) {
  const p = ProjectCategoryInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if ((await projectCategories.list()).some((x) => x.name === p.data.name && x.id !== selfId))
    return { error: t('分类「{name}」已存在', { name: p.data.name }) }
  if (p.data.workflowId && !(await workflows.get(p.data.workflowId))) return { error: t('工作流不存在') }
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
  return x ? c.json(x) : bad(c, t('分类不存在'), 404)
})

// 删除分类时，其中的项目变为未分类
app.delete('/project-categories/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await projectCategories.remove(id))) return bad(c, t('分类不存在'), 404)
  for (const p of await projects.list()) {
    if (p.categoryId === id) await projects.update(p.id, { ...p, categoryId: '' })
  }
  return c.body(null, 204)
})

// ---- 项目 ----
async function parseProject(body: unknown) {
  const p = ProjectInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if (p.data.categoryId && !(await projectCategories.get(p.data.categoryId))) return { error: t('项目分类不存在') }
  if (p.data.workflowId && !(await workflows.get(p.data.workflowId))) return { error: t('工作流不存在') }
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
  return x ? c.json(x) : bad(c, t('项目不存在'), 404)
})

app.delete('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const repo = (await projects.get(id))?.path
  if (!(await projects.remove(id))) return bad(c, t('项目不存在'), 404)
  await tasks.removeByProject(id, repo)
  return c.body(null, 204)
})

// ---- 任务 ----
const tasks = tasksApi({ agents, workflows, projects, projectCategories })
app.route('/tasks', tasks.routes)
app.route('/assist', assistApi({ agents, categories, workflows }))
// ---- UI 设计和连接浏览器的扩展 ----
const designs = designsApi({ projects })
app.post('/designs/browser/reveal', (c) => {
  const dir = extensionDir()
  if (!dir) return bad(c, t('没有找到扩展目录'))
  revealDir(dir)
  return c.json({ ok: true })
})
// 刷新扩展：1.3 起的扩展自己重新加载；更早的版本做不到，只能打开扩展页面让用户点刷新
app.post('/designs/browser/reload', async (c) => {
  const { browser } = (await c.req.json().catch(() => ({}))) as { browser?: string }
  if (extensionSelfReload(browserStatus().version)) {
    askExtensionReload()
    return c.json({ auto: true })
  }
  try {
    openExtensionsPage(String(browser ?? ''))
  } catch (e) {
    return bad(c, (e as Error).message)
  }
  return c.json({ auto: false })
})
// 安装扩展：打开浏览器的扩展页面和扩展所在的文件夹
app.post('/designs/browser/install', async (c) => {
  const { browser } = (await c.req.json().catch(() => ({}))) as { browser?: string }
  const dir = extensionDir()
  if (!dir) return bad(c, t('没有找到扩展目录'))
  try {
    openExtensionsPage(String(browser ?? ''))
  } catch (e) {
    return bad(c, (e as Error).message)
  }
  revealItem(dir)
  return c.json({ dir })
})
app.route('/designs', designs.routes)
app.route('/bridge', bridgeApi())
app.route('/asks', asksApi())
// AI 改设计用的工具（MCP）：CLI 直接调，地址里带这一轮的随机令牌
app.route('/mcp', designMcpApi())
app.route('/mcp', askMcpApi())
const docs = docsApi({ projects })
app.route('/project-docs', docs.routes)
app.route('/doc-jobs', docs.jobRoutes)

// ---- 附件和 @ 引用的项目文件 ----
app.route('/uploads/raw', uploadsRawApi())
app.route('/uploads', uploadsApi())
app.get('/projects/:id/files', async (c) => {
  const p = await projects.get(c.req.param('id'))
  if (!p?.path) return bad(c, t('这个项目还没有选择目录'))
  try {
    return c.json(await searchProjectFiles(p.path, c.req.query('q') ?? ''))
  } catch (e) {
    return bad(c, t('无法读取项目文件：{error}', { error: (e as Error).message }))
  }
})

// ---- 本地目录 ----
app.get('/fs/inspect', async (c) => c.json(await inspectDir(c.req.query('path') ?? '')))

// 在系统的文件管理器里打开项目目录；只接受已有项目的目录，不能用来打开任意路径
app.post('/fs/reveal', async (c) => {
  const { projectId } = (await c.req.json().catch(() => ({}))) as { projectId?: string }
  const p = (await projects.list()).find((x) => x.id === projectId)
  if (!p?.path) return bad(c, t('这个项目还没有选择目录'))
  const dir = resolvePath(p.path)
  const ok = await stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (!ok) return bad(c, t('目录不存在：{dir}', { dir }))
  revealDir(dir)
  return c.json({ ok: true })
})

app.get('/fs/list', async (c) => {
  try {
    return c.json(await listDir(c.req.query('path') ?? ''))
  } catch (e) {
    return bad(c, t('无法读取目录：{error}', { error: (e as Error).message }))
  }
})

// 选择项目目录时新建文件夹
app.post('/fs/mkdir', async (c) => {
  const { parent, name } = (await c.req.json().catch(() => ({}))) as { parent?: string; name?: string }
  try {
    return c.json({ path: await makeDir(String(parent ?? ''), String(name ?? '')) })
  } catch (e) {
    return bad(c, t('新建文件夹失败：{error}', { error: (e as Error).message }))
  }
})

app.route('/data', dataApi({ running: () => tasks.running() + designs.running() }))

app.route(
  '/app',
  updateApi({
    running: () => tasks.running() + designs.running(),
    // server 在下面才创建，重启时一定已经有了
    restart: () => (process.env.AGENT_PANEL_NO_RESTART ? undefined : restartProcess(() => server.close())),
  }),
)

void tasks.cleanupUploads()
// 启动时先在后台检测一遍 CLI，打开页面时直接用结果
void detectClis().catch(() => {})

const root = new Hono()
// 接口里没接住的错误：写进日志（带请求路径和调用栈），页面上照常看到错误信息
root.onError((e, c) => {
  log.error('http', `${c.req.method} ${c.req.path} 出错`, e)
  return c.json({ error: e.message || t('服务出错') }, 500)
})
root.use('*', tokenGuard)
root.route('/', app)
// 生产模式下直接托管前端构建产物
const prod = process.env.NODE_ENV === 'production' || process.argv.includes('--prod')
if (prod) {
  // 按程序所在目录找前端，不依赖从哪个目录启动
  const dist = path.join(appDir(), 'dist')
  root.use('/*', serveStatic({ root: dist }))
  root.get('*', serveStatic({ path: path.join(dist, 'index.html') }))
}

const port = Number(process.env.PORT ?? 8787)
// 更新后重启出来的进程：不再打开浏览器（页面已经开着），端口被旧进程占着时重试
const restarted = !!process.env.AGENT_PANEL_RESTARTED
// 由 Windows 托盘程序（AgentPanel.exe）启动
const tray = !!process.env.AGENT_PANEL_TRAY
delete process.env.AGENT_PANEL_RESTARTED
// 只监听本机：这个服务之后会启动本地 CLI，不应暴露到局域网
const server = serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, async () => {
  // 地址带上访问令牌：设置里打开令牌后，只有从这里打开的浏览器能访问
  const url = withToken(`http://127.0.0.1:${port}`)
  console.log(`Agent 面板服务已启动: ${url}`)
  log.info('server', '启动', { version: currentVersion(), data: DATA_DIR, log: logFile(), prod, tray, restarted })
  // 作为系统服务登录时自动启动的，不打开浏览器，免得每次开机都弹出来
  const open = prod && !restarted && !process.env.AGENT_PANEL_SUPERVISED && (await getSettings()).openBrowser
  if (tray) {
    // 托盘程序读这两行：显示地址，并由它打开浏览器（服务自己打开会经过 cmd）
    console.log(`AGENT_PANEL_READY ${url}`)
    if (open) console.log(`AGENT_PANEL_OPEN ${url}`)
  } else if (open) openBrowser(url)
})
/**
 * 退出前停掉正在执行的 CLI，并把任务状态落盘。macOS / Linux 上 CLI 跑在独立的进程组里，
 * 服务退出时不会跟着结束，不停掉的话会在后台继续改项目。最多等 5 秒。
 */
let exiting = false
async function shutdown(code = 0) {
  if (exiting) return process.exit(1)
  exiting = true
  log.info('server', '正在退出，停止正在执行的任务')
  server.close()
  await Promise.race([tasks.stopAll(), new Promise((r) => setTimeout(r, 5000))])
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown())
if (tray) {
  cleanupOldTray()
  // 托盘程序退出时会关掉服务的输入：停掉 CLI、收尾后退出
  process.stdin.on('end', () => void shutdown())
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
