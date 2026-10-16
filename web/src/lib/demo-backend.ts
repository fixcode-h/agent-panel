/**
 * 在线演示版的「后端」：在浏览器里实现和 server/index.ts 相同的接口，数据存在 localStorage。
 * 只在 VITE_DEMO 构建中使用；本机版本走真正的 Node 服务。
 */
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
  FollowUpInput,
  NewTaskInput,
  type Task,
  type CliStatus,
  type DirInfo,
  type DirListing,
} from '@shared/schema'
import { CLIS, getCli } from '@shared/clis'
import { newTask, runTurn } from '@shared/runner'

const KEY = 'agent-panel-demo-v1'

interface Db {
  agents: Agent[]
  categories: Category[]
  workflows: Workflow[]
  projectCategories: ProjectCategory[]
  projects: Project[]
  /** 旧版本的演示数据没有这一项，首次访问时补上示例任务 */
  tasks?: Task[]
}

class HttpError extends Error {}
const fail = (msg: string): never => {
  throw new HttpError(msg)
}

// ---- 模拟的本机目录 ----
const HOME = '/home/demo'
const TREE: Record<string, { git?: string }> = {
  '/home/demo': {},
  '/home/demo/code': {},
  '/home/demo/code/web-shop': { git: 'main' },
  '/home/demo/code/web-shop/src': {},
  '/home/demo/code/web-shop/tests': {},
  '/home/demo/code/admin-console': { git: 'develop' },
  '/home/demo/code/admin-console/src': {},
  '/home/demo/code/game-client': { git: 'release/1.2' },
  '/home/demo/code/game-client/Source': {},
  '/home/demo/code/game-client/Content': {},
  '/home/demo/code/notes': {},
  '/home/demo/Documents': {},
  '/home/demo/Downloads': {},
}

function normalize(p: string) {
  let t = p.trim() || HOME
  if (t === '~' || t.startsWith('~/')) t = HOME + t.slice(1)
  if (!t.startsWith('/')) t = `${HOME}/${t}`
  const parts: string[] = []
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

function inspectDir(p: string): DirInfo {
  const path = normalize(p)
  const node = TREE[path]
  return { path, exists: !!node, isDir: !!node, gitBranch: node?.git ?? null }
}

function listDir(p: string): DirListing {
  const path = normalize(p)
  if (path !== '/' && !TREE[path]) fail(`无法读取目录：${path} 不存在`)
  const prefix = path === '/' ? '/' : path + '/'
  const dirs = Object.keys(TREE)
    .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && k !== path)
    .map((k) => ({ name: k.slice(prefix.length), path: k }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (path === '/') dirs.push({ name: 'home', path: '/home' })
  const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/'
  return { path, parent, dirs }
}
TREE['/home'] = {}

// ---- 示例数据 ----
function seed(): Db {
  const now = new Date().toISOString()
  let n = 0
  const meta = () => ({ id: `demo-${++n}`, createdAt: now, updatedAt: now })
  const cat = (name: string): Category => ({ ...meta(), name })
  const plan = cat('规划')
  const dev = cat('开发')
  const qa = cat('质量')
  const agent = (o: Partial<AgentInput> & Pick<AgentInput, 'name' | 'cli'>): Agent => ({
    ...meta(),
    ...AgentInput.parse(o),
  })
  const arch = agent({
    name: '架构师',
    icon: 'brain',
    categoryId: plan.id,
    cli: 'claude',
    model: 'opus',
    description: '理解需求、拆分任务、分派并验收结果',
    instructions:
      '你是这个项目的技术负责人。先阅读工作流文档和需求，把任务拆成可独立验证的小步骤，分派给合适的子 Agent，并在每一步完成后检查结果。',
    extraArgs: ['--permission-mode', 'plan'],
  })
  const fe = agent({ name: '前端开发', icon: 'layout', categoryId: dev.id, cli: 'claude', model: 'sonnet', description: '实现 React 页面与交互，保证视觉还原' })
  const be = agent({ name: '后端开发', icon: 'database', categoryId: dev.id, cli: 'codex', model: 'gpt-5-codex', description: '实现 Node API、数据层与本机进程调度', extraArgs: ['--full-auto'] })
  const qaAgent = agent({ name: '测试工程师', icon: 'test', categoryId: qa.id, cli: 'claude', model: 'sonnet', description: '编写并运行单元测试与端到端测试' })
  const review = agent({ name: '代码审查', icon: 'shield', categoryId: qa.id, cli: 'claude', model: 'haiku', description: '检查改动的正确性与风格，给出修改建议', enabled: false })
  const docs = agent({ name: '文档助手', icon: 'doc', cli: 'claude', model: 'haiku', description: '整理 README 和变更说明' })

  const webFlow: Workflow = {
    ...meta(),
    name: 'Web 功能开发',
    description: '前后端一起改的常规功能需求',
    mainAgentId: arch.id,
    members: [
      { agentId: be.id, responsibility: '实现 API 与数据校验' },
      { agentId: fe.id, responsibility: '页面与交互' },
      { agentId: qaAgent.id, responsibility: '单测与端到端测试' },
    ],
    document: `# 目标
根据用户描述，在现有 Web 项目里完成一个新功能，并保证测试通过。

# 步骤
## 1. 分析需求、拆分任务 @架构师
阅读需求和相关代码，列出要改动的页面、接口和验收标准。

## 2. 实现接口 @后端开发
按第 1 步的接口设计实现 API，并补充数据校验。

## 3. 实现页面 @前端开发
对接第 2 步的接口，完成页面与交互。

## 4. 测试 @测试工程师
运行单元测试和端到端测试，失败时附上日志退回对应步骤。

## 5. 验收 @架构师
逐条对照验收标准检查结果。

# 完成标准
- 验收标准逐条满足
- 所有测试通过
`,
  }
  const bugFlow: Workflow = {
    ...meta(),
    name: 'Bug 修复',
    description: '复现、定位并修复缺陷',
    mainAgentId: arch.id,
    members: [{ agentId: qaAgent.id, responsibility: '复现问题' }],
    document: '',
  }
  const web: ProjectCategory = { ...meta(), name: 'Web 应用', description: '前后端分离的网站和后台', workflowId: webFlow.id }
  const game: ProjectCategory = { ...meta(), name: '游戏客户端', description: 'Unreal 客户端工程', workflowId: '' }
  const project = (o: ProjectInput): Project => ({ ...meta(), ...o })
  return {
    categories: [plan, dev, qa],
    agents: [arch, fe, be, qaAgent, review, docs],
    workflows: [webFlow, bugFlow],
    projectCategories: [web, game],
    projects: [
      project({ name: '商城前台', description: '面向用户的商城网站', path: '/home/demo/code/web-shop', categoryId: web.id, workflowId: '' }),
      project({ name: '运营后台', description: '内部运营管理系统', path: '/home/demo/code/admin-console', categoryId: web.id, workflowId: bugFlow.id }),
      project({ name: '客户端主工程', description: '', path: '/home/demo/code/game-client', categoryId: game.id, workflowId: '' }),
      project({ name: '旧官网', description: '已经下线的旧站点', path: '/home/demo/code/old-site', categoryId: '', workflowId: '' }),
    ],
  }
}

let db: Db | null = null
function load(): Db {
  if (db) return db
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) db = JSON.parse(raw) as Db
  } catch {}
  return (db ??= seed())
}
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {}
}

/** 清空演示数据，恢复示例 */
export function resetDemo() {
  db = seed()
  persist()
}

// ---- 通用增删改 ----
type Coll = keyof Db
function create<T extends { id: string }>(coll: Coll, input: object): T {
  const now = new Date().toISOString()
  const item = { ...input, id: `demo-${crypto.randomUUID()}`, createdAt: now, updatedAt: now } as unknown as T
  ;(load()[coll] as unknown as T[]).push(item)
  persist()
  return item
}
function update<T extends { id: string }>(coll: Coll, id: string, input: object, notFound: string): T {
  const list = load()[coll] as unknown as T[]
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) fail(notFound)
  list[i] = { ...list[i], ...input, id, updatedAt: new Date().toISOString() }
  persist()
  return list[i]
}
function remove(coll: Coll, id: string, notFound: string) {
  const d = load()
  const list = d[coll] as { id: string }[]
  if (!list.some((x) => x.id === id)) fail(notFound)
  ;(d[coll] as { id: string }[]) = list.filter((x) => x.id !== id)
  persist()
}
function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const p = schema.safeParse(body)
  if (!p.success) fail(z.prettifyError(p.error))
  return p.data as z.infer<S>
}

function clis(): CliStatus[] {
  return CLIS.map((c) => ({
    id: c.id,
    name: c.name,
    command: c.command,
    installed: c.id === 'claude',
    version: c.id === 'claude' ? '2.1.300 (Claude Code)' : undefined,
    models: c.models,
    docsUrl: c.docsUrl,
  }))
}

function route(method: string, url: string, body: unknown): unknown {
  const d = load()
  const [path, qs] = url.split('?')
  const query = new URLSearchParams(qs)
  const seg = path.split('/').filter(Boolean)
  const [res, id, sub] = seg

  if (res === 'clis') return clis()
  if (res === 'fs' && id === 'inspect') return inspectDir(query.get('path') ?? '')
  if (res === 'fs' && id === 'list') return listDir(query.get('path') ?? '')

  if (res === 'categories') {
    if (method === 'GET') return d.categories
    if (method === 'DELETE') {
      remove('categories', id, '分类不存在')
      d.agents = d.agents.map((a) => (a.categoryId === id ? { ...a, categoryId: '' } : a))
      persist()
      return undefined
    }
    const input = parse(CategoryInput, body)
    if (d.categories.some((c) => c.name === input.name && c.id !== id)) fail(`分类「${input.name}」已存在`)
    return method === 'POST' ? create('categories', input) : update('categories', id, input, '分类不存在')
  }

  if (res === 'agents') {
    if (method === 'GET') return d.agents
    if (method === 'DELETE') {
      const used = d.workflows.filter((w) => w.mainAgentId === id || w.members.some((m) => m.agentId === id))
      if (used.length) fail(`正在被工作流使用：${used.map((w) => `「${w.name}」`).join('、')}，请先从工作流中移除`)
      remove('agents', id, 'Agent 不存在')
      return undefined
    }
    const input = parse(AgentInput, body)
    if (!getCli(input.cli)) fail(`未知的 CLI：${input.cli}`)
    if (input.categoryId && !d.categories.some((c) => c.id === input.categoryId)) fail('分类不存在')
    return method === 'POST' ? create('agents', input) : update('agents', id, input, 'Agent 不存在')
  }

  if (res === 'workflows') {
    if (method === 'GET') return d.workflows
    if (method === 'DELETE') {
      const users = [
        ...d.projectCategories.filter((x) => x.workflowId === id).map((x) => `项目分类「${x.name}」`),
        ...d.projects.filter((x) => x.workflowId === id).map((x) => `项目「${x.name}」`),
      ]
      if (users.length) fail(`正在被使用：${users.join('、')}，请先改用其他工作流`)
      remove('workflows', id, '工作流不存在')
      return undefined
    }
    const wf = parse(WorkflowInput, body)
    const ids = new Set(d.agents.map((a) => a.id))
    if (wf.mainAgentId && !ids.has(wf.mainAgentId)) fail('主 Agent 不存在')
    const seen = new Set<string>([wf.mainAgentId])
    wf.members = wf.members.filter((m) => ids.has(m.agentId) && !seen.has(m.agentId) && !!seen.add(m.agentId))
    return method === 'POST' ? create('workflows', wf) : update('workflows', id, wf, '工作流不存在')
  }

  if (res === 'project-categories') {
    if (method === 'GET') return d.projectCategories
    if (method === 'DELETE') {
      remove('projectCategories', id, '分类不存在')
      d.projects = d.projects.map((p) => (p.categoryId === id ? { ...p, categoryId: '' } : p))
      persist()
      return undefined
    }
    const input = parse(ProjectCategoryInput, body)
    if (d.projectCategories.some((c) => c.name === input.name && c.id !== id)) fail(`分类「${input.name}」已存在`)
    if (input.workflowId && !d.workflows.some((w) => w.id === input.workflowId)) fail('工作流不存在')
    return method === 'POST' ? create('projectCategories', input) : update('projectCategories', id, input, '分类不存在')
  }

  if (res === 'projects') {
    if (method === 'GET') return d.projects
    if (method === 'DELETE') {
      remove('projects', id, '项目不存在')
      d.tasks = (d.tasks ?? []).filter((t) => t.projectId !== id)
      persist()
      return undefined
    }
    const input = parse(ProjectInput, body)
    if (input.categoryId && !d.projectCategories.some((c) => c.id === input.categoryId)) fail('项目分类不存在')
    if (input.workflowId && !d.workflows.some((w) => w.id === input.workflowId)) fail('工作流不存在')
    if (input.path) input.path = normalize(input.path)
    return method === 'POST' ? create('projects', input) : update('projects', id, input, '项目不存在')
  }

  if (res === 'tasks') return tasksRoute(method, id, sub, query, body)

  return fail(`未知接口：${method} ${path}${sub ? '/' + sub : ''}`)
}

export async function handle(method: string, url: string, body: unknown) {
  // 稍微延迟一下，模拟真实请求，让「保存中」等状态能被看到
  await new Promise((r) => setTimeout(r, 120))
  const d = load()
  if (!d.tasks) {
    d.tasks = []
    await seedTasks(d)
    persist()
  }
  const result = route(method, url, body)
  // 返回副本：执行中的任务会被原地修改，页面需要拿到新对象才会刷新
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
}

// 让类型检查确认演示数据结构与真实 schema 一致
export const __schemas = { Agent, Category, Workflow, ProjectCategory, Project }

// ---- 任务 ----
const live = new Map<string, { stop: boolean }>()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function projectWorkflow(d: Db, p: Project) {
  const id = p.workflowId || d.projectCategories.find((c) => c.id === p.categoryId)?.workflowId
  return d.workflows.find((w) => w.id === id)
}

function startTurn(d: Db, task: Task, prompt: string, first: boolean, fast = false) {
  const entry = { stop: false }
  live.set(task.id, entry)
  let last = 0
  const done = runTurn({
    task,
    agents: d.agents,
    workflow: d.workflows.find((w) => w.id === task.workflowId),
    prompt,
    first,
    sleep: fast ? async () => {} : sleep,
    stopped: () => entry.stop,
    changed: (flush) => {
      task.updatedAt = new Date().toISOString()
      // 流式输出时不必每个字都写 localStorage
      if (flush || Date.now() - last > 800) {
        last = Date.now()
        persist()
      }
    },
    newId: () => `demo-${crypto.randomUUID()}`,
  }).finally(() => {
    live.delete(task.id)
    persist()
  })
  return done
}

function createTask(d: Db, input: NewTaskInput, fast = false) {
  const project = d.projects.find((p) => p.id === input.projectId) ?? fail('项目不存在')
  let workflow: Workflow | undefined
  if (input.mode === 'workflow') {
    workflow = input.workflowId ? d.workflows.find((w) => w.id === input.workflowId) : projectWorkflow(d, project)
    if (!workflow) fail('项目还没有指定工作流，请选择一个工作流或改用直接对话')
  } else if (!d.agents.some((a) => a.id === input.agentId)) fail('请选择对话的 Agent')
  const task = create<Task>('tasks', newTask(input, workflow, d.agents, new Date().toISOString(), `demo-${crypto.randomUUID()}`))
  return { task, done: startTurn(d, task, input.prompt, true, fast) }
}

function followUp(d: Db, task: Task, text: string, fast = false) {
  if (live.has(task.id)) fail('任务正在执行，请等它完成或先停止')
  task.messages.push({ id: `demo-${crypto.randomUUID()}`, role: 'user', agentId: '', step: -1, text, tools: [], at: new Date().toISOString() })
  return startTurn(d, task, text, false, fast)
}

function tasksRoute(method: string, id: string | undefined, sub: string | undefined, query: URLSearchParams, body: unknown) {
  const d = load()
  const tasks = (d.tasks ??= [])
  if (!id) {
    if (method === 'GET') {
      const pid = query.get('projectId')
      return pid ? tasks.filter((t) => t.projectId === pid) : tasks
    }
    return createTask(d, parse(NewTaskInput, body)).task
  }
  const task = tasks.find((t) => t.id === id) ?? fail('任务不存在')
  if (method === 'DELETE') {
    if (live.has(id)) live.get(id)!.stop = true
    remove('tasks', id, '任务不存在')
    return undefined
  }
  if (sub === 'stop') {
    if (live.has(id)) live.get(id)!.stop = true
    return task
  }
  if (sub === 'messages') {
    void followUp(d, task, parse(FollowUpInput, body).text)
    return task
  }
  return task
}

/** 示例任务：用模拟执行一次性跑完，再把时间往前挪，看起来像之前做过的任务 */
async function seedTasks(d: Db) {
  const [shop, admin] = d.projects
  const fe = d.agents.find((a) => a.name === '前端开发')
  const back = (t: Task, minutes: number) => {
    const shift = (iso: string) => new Date(new Date(iso).getTime() - minutes * 60_000).toISOString()
    t.createdAt = shift(t.createdAt)
    t.updatedAt = shift(t.updatedAt)
    t.messages.forEach((m) => (m.at = shift(m.at)))
  }
  if (admin) {
    const { task, done } = createTask(d, { projectId: admin.id, mode: 'workflow', workflowId: '', agentId: '', prompt: '订单导出 Excel 时，日期列整体往右错了一列' }, true)
    await done
    back(task, 60 * 26)
  }
  if (shop && fe) {
    const { task, done } = createTask(d, { projectId: shop.id, mode: 'chat', workflowId: '', agentId: fe.id, prompt: '购物车右上角的数量角标偶尔不刷新，帮我看看原因' }, true)
    await done
    back(task, 60 * 3)
  }
  if (shop) {
    const { task, done } = createTask(
      d,
      {
        projectId: shop.id,
        mode: 'workflow',
        workflowId: '',
        agentId: '',
        prompt: '商品详情页增加「到货提醒」：商品缺货时显示按钮，用户点击后登记手机号，到货时发短信通知。',
      },
      true,
    )
    await done
    await followUp(d, task, '按钮文案改成「到货通知我」，已经登记过的用户显示「已登记」并置灰。', true)
    back(task, 25)
  }
}
