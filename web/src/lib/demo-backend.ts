/**
 * 在线演示版的「后端」：在浏览器里实现和 server/index.ts 相同的接口，数据存在 localStorage。
 * 只在 VITE_DEMO 构建中使用；本机版本走真正的 Node 服务。
 */
import { demoAccounts } from './demo-accounts'
import { demoLibrary } from './demo-library'
import { z } from 'zod'
import {
  Agent,
  DEFAULT_AGENT_ID,
  defaultAgent,
  Attachment,
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
  type Flow,
  type FlowNode,
  FollowUpInput,
  TaskPatch,
  NewTaskInput,
  Settings,
  type Task,
  type CliInstallJob,
  type CliModels,
  type CliUpdate,
  type CliLimits,
  type CliSkill,
  type SlashCommand,
  type CliStatus,
  type DirInfo,
  type DirListing,
} from '@shared/schema'
import { DATA_KINDS, type DataKind } from '@shared/data'
import { REPO, pickUpdate, type AppRelease, type AppReleases } from '@shared/version'
import { CLIS, getCli } from '@shared/clis'
import {
  BUILTIN_WORKFLOWS,
  ComfyWorkflow,
  localModel,
  localFile,
  modelReady,
  type LocalJob,
  type LocalStatus,
} from '@shared/local-image'
import { defaultCli, orderClis } from '@shared/settings'
import { runTurn, simAnswers } from '@shared/runner'
import { chatMissingParams } from '@shared/agent-role'
import { beginRun, endRun, newTask, questionAnswers, taskSummary, withAttachments } from '@shared/task'
import { END, START, autoLayout, edge, newFlow, newNode, taskWorkflows, workflowClosure } from '@shared/flow'
import { AssistInput } from '@shared/assist'
import { demoAssistJob, startDemoAssist, stopDemoAssist } from './demo-assist'
import { demoDocJob, demoDocs, saveDemoDoc, startDemoDocJob, stopDemoDocJob } from './demo-docs'
import {
  demoDesigns,
  demoGenerate,
  demoImportComponent,
  demoProjectComponents,
  demoStyles,
  demoExtractStyle,
  demoVersions,
} from './demo-design'
import { agentDeleteError, checkWorkflow, workflowDeleteError } from '@shared/validate'

const KEY = 'agent-panel-demo-v3'

interface Db {
  agents: Agent[]
  categories: Category[]
  /** 旧版本的演示数据没有标签 */
  tags?: Tag[]
  workflows: Workflow[]
  projectCategories: ProjectCategory[]
  projects: Project[]
  /** 旧版本的演示数据没有这一项，首次访问时补上示例任务 */
  tasks?: Task[]
  settings?: Settings
  /** 在线演示里模拟安装 / 卸载后的 CLI 状态 */
  installed?: Record<string, boolean>
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
  return {
    path,
    parent,
    dirs,
    roots: [
      { name: '主目录', path: HOME },
      { name: '/', path: '/' },
    ],
  }
}
TREE['/home'] = {}

// ---- 示例数据 ----
function seed(): Db {
  const now = new Date().toISOString()
  let n = 0
  const meta = () => ({ id: `demo-${++n}`, createdAt: now, updatedAt: now })
  const cat = (name: string, scope: Category['scope'] = 'agent'): Category => ({ ...meta(), name, scope })
  const plan = cat('规划')
  const dev = cat('开发')
  const qa = cat('质量')
  const wfDev = cat('功能开发', 'workflow')
  const wfFix = cat('问题处理', 'workflow')
  const tag = (name: string, color: Tag['color'], description = ''): Tag => ({ ...meta(), name, color, description })
  const tWeb = tag('Web', 'blue', '网站和后台相关')
  const tQuality = tag('质量', 'green', '测试、审查、验收')
  const tCommon = tag('常用', 'amber')
  const agent = (o: Partial<AgentInput> & Pick<AgentInput, 'name' | 'cli'>): Agent => ({
    ...meta(),
    ...AgentInput.parse(o),
  })
  const arch = agent({
    name: '架构师',
    icon: 'brain',
    categoryId: plan.id,
    cli: 'claude',
    model: 'claude-opus-5-5',
    description: '理解需求、拆分任务、分派并验收结果',
    instructions:
      '你是这个项目的技术负责人。先阅读工作流文档和需求，把任务拆成可独立验证的小步骤，分派给合适的子 Agent，并在每一步完成后检查结果。',
  })
  const fe = agent({
    name: '前端开发',
    icon: 'layout',
    categoryId: dev.id,
    cli: 'claude',
    model: 'claude-sonnet-5-5',
    description: '实现 React 页面与交互，保证视觉还原',
  })
  const be = agent({
    name: '后端开发',
    icon: 'database',
    categoryId: dev.id,
    cli: '',
    model: '@high',
    effort: 'xhigh',
    description: '实现 Node API、数据层与本机进程调度',
  })
  const qaAgent = agent({
    name: '测试工程师',
    icon: 'test',
    categoryId: qa.id,
    cli: '',
    model: '@medium',
    description: '编写并运行单元测试与端到端测试',
    tags: [tQuality.id, tWeb.id],
  })
  const review = agent({
    name: '代码审查',
    icon: 'shield',
    categoryId: qa.id,
    cli: 'claude',
    model: 'claude-haiku-5-5',
    description: '检查改动的正确性与风格，给出修改建议',
    enabled: false,
    tags: [tQuality.id],
    instructions: `# 角色
你负责审查代码改动，只提意见，不直接改代码。

# 重点
重点检查：{{focus}}

{{#if level=严格}}
逐行检查改动，包括命名、注释和边界情况；有任何疑问都列出来。
{{else}}{{#if level=快速}}
只看会导致错误行为的问题，风格问题一概不提。
{{else}}
先看正确性，其次是可读性；纯格式问题不提。
{{/if}}{{/if}}

# 输出
按严重程度从高到低列出问题，每条写明文件和行号。`,
    params: [
      {
        key: 'level',
        label: '审查力度',
        type: 'select',
        options: ['快速', '标准', '严格'],
        default: '标准',
        ask: false,
        description: '严格会逐行检查，快速只看会出错的地方',
      },
      {
        key: 'focus',
        label: '关注点',
        type: 'multi',
        options: ['正确性', '安全', '性能', '可读性'],
        default: ['正确性', '安全'],
        ask: false,
        description: '',
      },
    ],
    starters: ['审查工作区里还没提交的改动', '审查当前分支相对 main 的改动'],
  })
  const docs = agent({
    name: '文档助手',
    icon: 'doc',
    cli: '',
    model: '@low',
    description: '整理 README 和变更说明',
    tags: [tCommon.id],
    params: [
      {
        key: 'audience',
        label: '读者',
        type: 'select',
        options: ['用户', '开发者'],
        ask: true,
        description: '写给谁看：用户看功能和用法，开发者看结构和接口',
      },
    ],
    instructions: '你负责整理文档。这次的读者是{{audience}}，按读者关心的内容组织，不要堆砌实现细节。',
    starters: ['根据最近的提交整理一份更新说明', '检查 README 里过时的内容'],
  })

  const node = (title: string, agentId: string, instructions: string, hooks: Partial<FlowNode['hooks']> = {}) =>
    newNode({
      title,
      agentId,
      instructions,
      x: 0,
      y: 0,
      hooks: { start: null, review: null, end: null, maxRounds: 3, ...hooks },
    })
  /** 按连线组成流程，位置自动排列；links 用节点下标，-1 表示开始 / 结束 */
  const graph = (f: Flow, nodes: FlowNode[], links: [number, number][]): Flow =>
    autoLayout({
      ...f,
      nodes,
      edges: links.map(([a, b]) => edge(a < 0 ? START : nodes[a].id, b < 0 ? END : nodes[b].id)),
    })

  const reviewFlow = graph(
    { ...newFlow('代码审查'), description: '检查改动的正确性、可读性和测试覆盖，给出通过或不通过' },
    [
      node(
        '审查改动',
        '',
        '逐个查看上游节点改动的文件：逻辑是否正确、边界情况、命名和风格是否符合项目约定、有没有补测试。列出必须修改的问题。',
      ),
    ],
    [
      [-1, 0],
      [0, -1],
    ],
  )
  const ctxFlow = graph(
    { ...newFlow('收集上下文'), description: '找出和需求相关的代码、接口和历史改动' },
    [node('查找相关代码', '', '根据需求搜索相关的页面、接口和数据结构，列出文件路径和关键函数，供后续节点参考。')],
    [
      [-1, 0],
      [0, -1],
    ],
  )
  const reviewRef = { kind: 'sub' as const, id: reviewFlow.id }
  const webMain = graph(
    newFlow('主流程', 'main'),
    [
      node('分析需求、拆分任务', '', '阅读需求和相关代码，列出要改动的页面、接口和验收标准，并给前后端分好工。', {
        start: { kind: 'sub', id: ctxFlow.id },
      }),
      node('实现接口', be.id, '按分析阶段的接口设计实现 API，并补充数据校验。', { review: reviewRef }),
      node('实现页面', fe.id, '按分析阶段约定的接口完成页面与交互，接口没好之前先用假数据。', {
        review: reviewRef,
      }),
      node('单元测试', qaAgent.id, '为新增的接口和组件补充单元测试并运行。'),
      node('端到端测试', qaAgent.id, '跑一遍主要流程的端到端测试，失败时附上日志。'),
      node('验收', '', '逐条对照验收标准检查结果，列出没满足的地方。'),
    ],
    [
      [-1, 0],
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [1, 4],
      [2, 4],
      [3, 5],
      [4, 5],
      [5, -1],
    ],
  )
  const webFlow: Workflow = {
    ...meta(),
    name: 'Web 功能开发',
    description: '前后端一起改的常规功能需求',
    categoryId: wfDev.id,
    tags: [tWeb.id, tCommon.id],
    mainAgentId: arch.id,
    members: [
      { agentId: be.id, responsibility: '实现 API 与数据校验' },
      { agentId: fe.id, responsibility: '页面与交互' },
      { agentId: qaAgent.id, responsibility: '单测与端到端测试' },
    ],
    flows: [webMain, reviewFlow, ctxFlow],
    entryFlowId: 'main',
    document: `# 目标
根据用户描述，在现有 Web 项目里完成一个新功能，并保证测试通过。

# 规范
- 接口改动同步更新 \`shared/schema.ts\` 里的类型
- 新增页面要适配移动端

# 完成标准
- 验收标准逐条满足
- 所有测试通过
`,
  }
  const bugFlow: Workflow = {
    ...meta(),
    name: 'Bug 修复',
    description: '复现、定位并修复缺陷',
    categoryId: wfFix.id,
    tags: [tQuality.id],
    mainAgentId: arch.id,
    members: [{ agentId: qaAgent.id, responsibility: '复现问题' }],
    flows: [
      graph(
        newFlow('主流程', 'main'),
        [
          node('复现问题', qaAgent.id, '按描述复现问题，写一个能稳定失败的测试。'),
          node('定位并修复', '', '找到原因并修复，让上一步的测试通过。'),
          node('回归测试', qaAgent.id, '运行全部测试，确认没有引入新问题。'),
        ],
        [
          [-1, 0],
          [0, 1],
          [1, 2],
          [2, -1],
        ],
      ),
    ],
    entryFlowId: 'main',
    document: '',
  }
  const web: ProjectCategory = {
    ...meta(),
    name: 'Web 应用',
    description: '前后端分离的网站和后台',
    workflowId: webFlow.id,
  }
  const game: ProjectCategory = { ...meta(), name: '游戏客户端', description: 'Unreal 客户端工程', workflowId: '' }
  const project = (o: ProjectInput): Project => ({ ...meta(), ...o })
  return {
    categories: [plan, dev, qa, wfDev, wfFix],
    tags: [tWeb, tQuality, tCommon],
    agents: [arch, fe, be, qaAgent, review, docs],
    workflows: [webFlow, bugFlow],
    projectCategories: [web, game],
    projects: [
      project({
        name: '商城前台',
        description: '面向用户的商城网站',
        path: '/home/demo/code/web-shop',
        categoryId: web.id,
        workflowId: '',
      }),
      project({
        name: '运营后台',
        description: '内部运营管理系统',
        path: '/home/demo/code/admin-console',
        categoryId: web.id,
        workflowId: bugFlow.id,
      }),
      project({
        name: '客户端主工程',
        description: '',
        path: '/home/demo/code/game-client',
        categoryId: game.id,
        workflowId: '',
      }),
      project({
        name: '旧官网',
        description: '已经下线的旧站点',
        path: '/home/demo/code/old-site',
        categoryId: '',
        workflowId: '',
      }),
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
  db ??= seed()
  // 旧的演示数据、导入的数据缺新加的字段（标签、参数……）：按现在的结构补齐默认值
  db.agents = db.agents.map((a) => Agent.parse(a))
  db.workflows = db.workflows.map((w) => Workflow.parse(w))
  db.categories = db.categories.map((c) => Category.parse(c))
  db.tags ??= []
  // 自带的默认 Agent：旧的演示数据、导入的数据里没有时补上
  if (!db.agents.some((a) => a.id === DEFAULT_AGENT_ID)) db.agents.unshift(defaultAgent())
  return db
}
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {}
}

// ---- 设置里的「数据」：演示没有用户目录，按浏览器里存的演示数据估算占用，导入导出用同样的备份格式 ----
const DEMO_DATA_FILES: Record<Exclude<DataKind, 'uploads' | 'cache'>, (d: Db) => Record<string, unknown>> = {
  config: (d) => ({
    'settings.json': d.settings ?? Settings.parse({}),
    'config/agents.json': d.agents,
    'config/categories.json': d.categories,
    'config/tags.json': d.tags ?? [],
    'config/workflows.json': d.workflows,
    'config/project-categories.json': d.projectCategories,
  }),
  projects: (d) => ({ 'projects/projects.json': d.projects }),
  tasks: (d) => ({ 'tasks/tasks.json': d.tasks ?? [] }),
}
const utf8ToB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64ToUtf8 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)))

function demoData(d: Db, action: string | undefined, method: string, body: unknown, query: URLSearchParams): unknown {
  if (!action && method === 'GET') {
    const kinds = DATA_KINDS.map((k) => {
      if (k.id === 'uploads') {
        const sizes = [...demoUploads.values()].map((u) => Math.floor((u.length * 3) / 4))
        return { id: k.id, files: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) }
      }
      if (k.id === 'cache') return { id: k.id, files: 0, bytes: 0 }
      const files = Object.values(DEMO_DATA_FILES[k.id](d))
      return { id: k.id, files: files.length, bytes: files.reduce<number>((n, v) => n + JSON.stringify(v).length, 0) }
    })
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
    return { dir: '~/.agent-panel（在线演示，数据存在浏览器里）', kinds, memory: { rss: heap, heapUsed: heap } }
  }
  if (action === 'reveal') fail('在线演示不能打开本机目录')
  if (action === 'clear') {
    const k = (body as { kind: DataKind }).kind
    if (k === 'projects') d.projects = []
    if (k === 'projects' || k === 'tasks') d.tasks = []
    if (k === 'uploads') demoUploads.clear()
    persist()
    return { ok: true }
  }
  if (action === 'export') {
    const kinds = (query.get('kinds') ?? '')
      .split(',')
      .filter((k): k is keyof typeof DEMO_DATA_FILES => k in DEMO_DATA_FILES)
    if (!kinds.length) fail('请选择要导出的数据')
    const files: Record<string, string> = {}
    for (const k of kinds)
      for (const [rel, v] of Object.entries(DEMO_DATA_FILES[k](d))) files[rel] = utf8ToB64(JSON.stringify(v, null, 2))
    return { app: 'agent-panel', version: 1, exportedAt: new Date().toISOString(), kinds, files }
  }
  if (action === 'import') {
    const b = body as { app?: string; kinds?: DataKind[]; files?: Record<string, string> }
    if (b?.app !== 'agent-panel' || !b.files || !Array.isArray(b.kinds)) fail('不是 Agent 面板导出的数据文件')
    const kinds = b.kinds ?? []
    const files = b.files ?? {}
    const get = (rel: string) => (files[rel] ? JSON.parse(b64ToUtf8(files[rel])) : undefined)
    if (kinds.includes('config')) {
      d.settings = Settings.parse(get('settings.json') ?? {})
      d.agents = get('config/agents.json') ?? []
      d.categories = get('config/categories.json') ?? []
      d.tags = get('config/tags.json') ?? []
      d.workflows = get('config/workflows.json') ?? []
      d.projectCategories = get('config/project-categories.json') ?? []
    }
    if (kinds.includes('projects')) d.projects = get('projects/projects.json') ?? []
    if (kinds.includes('tasks')) d.tasks = get('tasks/tasks.json') ?? []
    persist()
    return { ok: true, kinds, files: Object.keys(files).length }
  }
  fail('不支持的操作')
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

const VERSIONS: Record<string, string> = {
  claude: '2.1.300 (Claude Code)',
  codex: 'codex-cli 0.150.0',
  commandcode: 'command-code 1.8.2',
}
// npm 上的「最新版本」：Claude Code 演示有更新可装
const LATEST: Record<string, string> = { claude: '2.1.301', codex: '0.150.0', commandcode: '1.8.2' }

function clis(): CliStatus[] {
  const d = load()
  const s = d.settings
  return orderClis(CLIS, s?.cliOrder ?? []).map((c) => {
    const installed = d.installed?.[c.id] ?? c.id === 'claude'
    return {
      id: c.id,
      name: c.name,
      command: s?.clis[c.id]?.command || c.command,
      enabled: s?.clis[c.id]?.enabled ?? true,
      installed,
      isDefault: c.id === (s ? defaultCli(s) : 'claude'),
      version: installed ? VERSIONS[c.id] : undefined,
      error: installed ? undefined : '在线演示：模拟为未安装',
      models: c.models,
      docsUrl: c.docsUrl,
    }
  })
}

// 模拟安装 / 卸载：几秒内逐行输出，然后切换安装状态
const installJobs = new Map<string, CliInstallJob>()
function cliAction(id: string, action: CliInstallJob['action']) {
  const def = getCli(id) ?? fail('未知的 CLI')
  if ([...installJobs.values()].some((j) => j.status === 'running')) fail('有一个安装 / 卸载还在进行，请等它完成')
  const job: CliInstallJob = {
    id: `demo-${crypto.randomUUID()}`,
    cli: id,
    action,
    status: 'running',
    command: action === 'install' ? `npm install -g ${def.npmPackage}@latest` : `npm uninstall -g ${def.npmPackage}`,
    log: '',
  }
  installJobs.set(job.id, job)
  const lines =
    action === 'install'
      ? [
          '（在线演示：模拟安装，不会真的执行 npm）',
          `npm http fetch GET 200 https://registry.npmjs.org/${def.npmPackage}`,
          'npm warn deprecated node-domexception@1.0.0',
          '',
          `added 3 packages in 2s`,
        ]
      : ['（在线演示：模拟卸载，不会真的执行 npm）', '', 'removed 3 packages in 1s']
  lines.forEach((l, i) =>
    setTimeout(
      () => {
        job.log += l + '\n'
        if (i < lines.length - 1) return
        const d = load()
        d.installed = { ...d.installed, [id]: action === 'install' }
        if (action === 'install') VERSIONS[id] = VERSIONS[id].replace(/\d+\.\d+\.\d+/, LATEST[id])
        persist()
        job.cliStatus = clis().find((c) => c.id === id)
        job.status = 'done'
      },
      500 * (i + 1),
    ),
  )
  return job
}

/** 演示上传的附件内容（data URL），刷新页面后就没了 */
export const demoUploads = new Map<string, string>()

/** 演示项目里的文件，输入 @ 时从这里找 */
const DEMO_FILES = [
  'package.json',
  'README.md',
  'vite.config.ts',
  'src/main.tsx',
  'src/App.tsx',
  'src/api/cart.ts',
  'src/api/orders.ts',
  'src/api/products.ts',
  'src/components/CartBadge.tsx',
  'src/components/ProductCard.tsx',
  'src/components/RestockButton.tsx',
  'src/pages/Login.tsx',
  'src/pages/OrderList.tsx',
  'src/pages/ProductDetail.tsx',
  'src/store/cart.ts',
  'src/utils/date.ts',
  'src/utils/format.ts',
  'tests/cart.test.ts',
]

/** 演示的 Skill 列表：用户级的总是有，选了项目时多一个项目里的 */
const DEMO_SKILLS: CliSkill[] = [
  {
    name: 'frontend-design',
    description: '做界面时按设计规范出稿，注意配色、间距和动效',
    scope: 'user',
    path: '~/.agents/skills/frontend-design/SKILL.md',
    enabled: true,
    source: '~/.agents/skills',
  },
  {
    name: 'pdf',
    description: '读取、合并、拆分 PDF，填写表单',
    scope: 'user',
    path: '~/.agents/skills/pdf/SKILL.md',
    enabled: true,
    source: '~/.agents/skills',
  },
  {
    name: 'commit-message',
    description: '按团队约定写提交说明',
    scope: 'user',
    path: '~/.claude/skills/commit-message/SKILL.md',
    enabled: true,
    source: '~/.claude/skills',
  },
  {
    name: 'release-notes',
    description: '按仓库的提交说明格式整理更新说明',
    scope: 'repo',
    path: './.agents/skills/release-notes/SKILL.md',
    enabled: true,
    source: './.agents/skills',
  },
]

/** 演示的自定义命令：每个 CLI 不一样 */
const DEMO_COMMANDS: Record<string, SlashCommand[]> = {
  claude: [
    {
      name: 'commit',
      description: '看一下改动，按约定写提交说明并提交',
      kind: 'command',
      source: '~/.claude/commands',
    },
    {
      name: 'fix-issue',
      description: '按 issue 编号修复问题',
      kind: 'command',
      source: './.claude/commands',
      hint: '<编号>',
    },
  ],
  codex: [{ name: 'prompts:explain', description: '解释一段代码的作用', kind: 'command', source: '~/.codex/prompts' }],
}

/** 本机生图的演示：模拟安装、下载的进度，演示里没有真的 ComfyUI */
const local: LocalStatus = {
  dir: '~/agent-panel/comfyui',
  installed: false,
  running: false,
  external: false,
  url: 'http://127.0.0.1:8188',
  python: '3.12',
  gpu: 'cuda',
  gpuName: 'NVIDIA GeForce RTX 4090',
  vram: 24,
  files: [],
}
let demoWorkflows: ComfyWorkflow[] = []
function demoLocal(method: string, seg: string[], body: unknown): unknown {
  const [, action, id, sub] = seg
  if (action === 'workflows') {
    if (id === 'assist') {
      // 演示没有 AI：在参考的工作流上做一点改动，说明一下
      const b = body as { kind: 'game' | 'web'; instruction: string; base?: ComfyWorkflow }
      const base = b.base ?? BUILTIN_WORKFLOWS.find((w) => w.kind === b.kind)!
      return {
        workflow: {
          ...base,
          id: b.base && !b.base.builtin ? b.base.id : `wf_${Date.now().toString(36)}`,
          name: b.base ? `${base.name}（优化）` : b.instruction.slice(0, 20),
          builtin: undefined,
          extra: [base.extra, 'high detail, crisp clean edges'].filter(Boolean).join(' '),
        },
        note: '演示：在参考工作流的基础上加强了清晰度要求（真实环境里由 AI 按你的要求改写节点和参数）。',
      }
    }
    if (method === 'PUT' && id) {
      const wf = { ...parse(ComfyWorkflow, { ...(body as object), id }), builtin: undefined }
      demoWorkflows = demoWorkflows.some((w) => w.id === id)
        ? demoWorkflows.map((w) => (w.id === id ? wf : w))
        : [...demoWorkflows, wf]
      return wf
    }
    if (method === 'DELETE' && id) {
      demoWorkflows = demoWorkflows.filter((w) => w.id !== id)
      return { ok: true }
    }
    const list = [...BUILTIN_WORKFLOWS, ...demoWorkflows]
    const ready = list.filter((w) => !w.model || (localModel(w.model) && modelReady(localModel(w.model)!, local)))
    return { list, ready: ready.map((w) => w.id) }
  }
  const tick = (steps: string[], done: () => void, total = 0) => {
    const j: LocalJob = (local.job = {
      id: String(Date.now()),
      kind: total ? 'download' : 'install',
      status: 'running',
      step: steps[0],
      log: '',
      progress: total ? { done: 0, total } : undefined,
    })
    let i = 0
    const timer = setInterval(() => {
      i++
      if (j.progress) j.progress.done = Math.min(total, (total * i) / 8)
      const step = steps[Math.min(steps.length - 1, Math.floor((i * steps.length) / 8))]
      if (step !== j.step) j.log += `${j.step}\n`
      j.step = step
      if (i < 8) return
      clearInterval(timer)
      j.status = 'done'
      done()
    }, 400)
  }
  if (action === 'install' && method === 'POST')
    tick(
      ['检查 Python', '下载 ComfyUI', '创建 Python 虚拟环境', '安装 PyTorch', '安装 ComfyUI 的依赖', '安装完成'],
      () => {
        local.installed = true
      },
    )
  if (action === 'start') local.running = local.installed
  if (action === 'stop') local.running = false
  if (action === 'cancel' && local.job) local.job.status = 'failed'
  if (action === 'models' && id) {
    const m = localModel(id)
    if (m && sub === 'download')
      tick(
        m.files.map((f) => `下载 ${localFile(f)!.file}`),
        () => (local.files = [...new Set([...local.files, ...m.files])]),
        m.files.reduce((n, f) => n + localFile(f)!.gb * 1024 ** 3, 0),
      )
    if (m && method === 'DELETE') local.files = local.files.filter((f) => !m.files.includes(f))
  }
  return structuredClone(local)
}

function route(method: string, url: string, body: unknown): unknown {
  const d = load()
  const [path, qs] = url.split('?')
  const query = new URLSearchParams(qs)
  const seg = path.split('/').filter(Boolean)
  const [res, id, sub] = seg

  if (res === 'settings') {
    if (method === 'PUT') d.settings = parse(Settings, body)
    persist()
    return Settings.parse((d.settings ??= Settings.parse({})))
  }
  if (res === 'local-image') return demoLocal(method, seg, body)
  if (res === 'accounts') return demoAccounts(method, seg, body ?? {})
  if (res === 'library' || res === 'mcp-tools') return demoLibrary(method, seg, query, body ?? {})
  if (res === 'clis') {
    if (id === 'jobs' && !sub) {
      const latest = new Map<string, CliInstallJob>()
      for (const j of installJobs.values()) latest.set(j.cli, j)
      return [...latest.values()]
    }
    if (id === 'jobs') return installJobs.get(sub ?? '') ?? fail('没有这个操作')
    if (id && (sub === 'install' || sub === 'uninstall')) return cliAction(id, sub)
    if (id && sub === 'update') {
      const cur = clis().find((c) => c.id === id)
      const current = /\d+\.\d+\.\d+/.exec(cur?.version ?? '')?.[0]
      return {
        current,
        latest: LATEST[id],
        available: !!cur?.installed && !!current && current !== LATEST[id],
      } satisfies CliUpdate
    }
    // 额度和 Skill：演示没有本机 CLI，给一份看起来像真的数据
    if (id && sub === 'limits') {
      if (id !== 'codex' && id !== 'claude') return null
      const h = 3_600_000
      return {
        windows: [
          {
            id: id === 'codex' ? 'primary' : 'five_hour',
            usedPercent: 42,
            resetsAt: Date.now() + 2.4 * h,
            minutes: 300,
          },
          {
            id: id === 'codex' ? 'secondary' : 'seven_day',
            usedPercent: 18,
            resetsAt: Date.now() + 96 * h,
            minutes: 10080,
          },
        ],
        plan: id === 'codex' ? 'plus' : 'max',
        at: new Date().toISOString(),
      } satisfies CliLimits
    }
    if (id === 'specs') return { specs: [], errors: [], dir: '~/.agent-panel/config/clis' }
    if (id && sub === 'commands')
      return [
        ...(DEMO_COMMANDS[id] ?? []),
        ...DEMO_SKILLS.filter((x) => query.get('projectId') || x.scope !== 'repo').map((x) => ({
          name: x.name,
          description: x.description,
          kind: 'skill' as const,
          source: x.source ?? '',
        })),
      ] satisfies SlashCommand[]
    if (id && sub === 'skills') return DEMO_SKILLS.filter((x) => query.get('projectId') || x.scope !== 'repo')
    if (id && sub === 'models') {
      // 演示没有本机 CLI，给出内置的建议列表
      const def = CLIS.find((c) => c.id === id) ?? fail(`未知的 CLI：${id}`)
      return {
        source: 'builtin',
        models: [
          ...def.models.map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault, origin: 'cli' as const })),
          // 演示配置文件里接了一个第三方 API，下拉里分成两组
          ...(id === 'codex'
            ? [
                {
                  id: 'deepseek-v4-pro',
                  label: 'deepseek-v4-pro',
                  description: 'profile「deepseek」',
                  origin: 'config' as const,
                },
              ]
            : []),
        ],
        efforts: [],
      } satisfies CliModels
    }
    return clis()
  }
  if (res === 'assist') {
    if (method === 'POST' && !id) {
      const input = parse(AssistInput, body)
      const target = input.targetId
        ? (input.kind === 'agent' ? d.agents : d.workflows).find((x) => x.id === input.targetId)
        : undefined
      const settings = Settings.parse(d.settings ?? {})
      return startDemoAssist(input, {
        agents: d.agents,
        categories: d.categories,
        workflows: d.workflows,
        rules:
          input.kind === 'agent'
            ? settings.assist.agentRules
            : input.kind === 'workflow'
              ? settings.assist.workflowRules
              : '',
        subject: input.subject,
        defaultCli: defaultCli(settings),
        target,
      })
    }
    if (sub === 'stop') return stopDemoAssist(id) ?? fail('找不到这次生成')
    return demoAssistJob(id) ?? fail('找不到这次生成，可能已过期')
  }
  // 附件：演示没有本机磁盘，内容留在页面内存里给缩略图用，路径是假的
  if (res === 'uploads' && method === 'POST') {
    const u = body as { name: string; mime: string; data: string }
    const a: Attachment = {
      name: u.name,
      path: `/demo/uploads/${crypto.randomUUID()}/${u.name}`,
      size: Math.floor((u.data.length * 3) / 4),
      mime: u.mime,
    }
    demoUploads.set(a.path, `data:${u.mime || 'application/octet-stream'};base64,${u.data}`)
    return a
  }
  if (res === 'data') return demoData(d, id, method, body, query)
  if (res === 'project-docs') {
    const p = d.projects.find((x) => x.id === id) ?? fail('项目不存在')
    if (sub === 'optimize') return startDemoDocJob(body)
    return method === 'PUT' ? saveDemoDoc(id, body) : demoDocs(id, p.path)
  }
  if (res === 'doc-jobs')
    return (sub === 'stop' ? stopDemoDocJob(id) : demoDocJob(id)) ?? fail('找不到这次优化，可能已过期')
  if (res === 'projects' && id && sub === 'files') {
    const q = (query.get('q') ?? '').toLowerCase()
    return DEMO_FILES.filter((f) => f.toLowerCase().includes(q)).slice(0, 30)
  }
  if (res === 'fs' && id === 'inspect') return inspectDir(query.get('path') ?? '')
  if (res === 'fs' && id === 'list') return listDir(query.get('path') ?? '')
  if (res === 'fs' && id === 'mkdir') {
    const b = body as { parent: string; name: string }
    const name = b.name.trim()
    if (!name || /[<>:"/\\|?*]/.test(name)) fail('新建文件夹失败：文件夹名不对')
    const parent = normalize(b.parent)
    const full = (parent === '/' ? '' : parent) + '/' + name
    if (TREE[full]) fail(`新建文件夹失败：「${name}」已经存在`)
    TREE[full] = {}
    return { path: full }
  }
  if (res === 'fs' && id === 'reveal') throw new Error('在线演示不能打开本机目录')

  if (res === 'categories') {
    if (method === 'GET') return d.categories
    if (method === 'DELETE') {
      remove('categories', id, '分类不存在')
      d.agents = d.agents.map((a) => (a.categoryId === id ? { ...a, categoryId: '' } : a))
      d.workflows = d.workflows.map((w) => (w.categoryId === id ? { ...w, categoryId: '' } : w))
      persist()
      return undefined
    }
    const input = parse(CategoryInput, body)
    // 改名时不带 scope：沿用原来的
    const scope = d.categories.find((c) => c.id === id)?.scope ?? input.scope
    if (d.categories.some((c) => c.name === input.name && c.scope === scope && c.id !== id))
      fail(`分类「${input.name}」已存在`)
    return method === 'POST' ? create('categories', input) : update('categories', id, { ...input, scope }, '分类不存在')
  }

  if (res === 'tags') {
    if (method === 'GET') return (d.tags ??= [])
    if (method === 'DELETE') {
      remove('tags', id, '标签不存在')
      const drop = <T extends { tags: string[] }>(x: T) => ({ ...x, tags: x.tags.filter((t) => t !== id) })
      d.agents = d.agents.map(drop)
      d.workflows = d.workflows.map(drop)
      persist()
      return undefined
    }
    const input = parse(TagInput, body)
    d.tags ??= []
    if (d.tags.some((x) => x.name === input.name && x.id !== id)) fail(`标签「${input.name}」已存在`)
    return method === 'POST' ? create('tags', input) : update('tags', id, input, '标签不存在')
  }

  if (res === 'agents') {
    if (method === 'GET') return d.agents
    if (method === 'DELETE') {
      const err = agentDeleteError(id, d.workflows)
      if (err) fail(err)
      remove('agents', id, 'Agent 不存在')
      d.agents = d.agents.map((a) => ({ ...a, includes: a.includes.filter((x) => x !== id) }))
      persist()
      return undefined
    }
    const input = parse(AgentInput, body)
    if (input.cli && !getCli(input.cli)) fail(`未知的 CLI：${input.cli}`)
    if (input.categoryId && !d.categories.some((c) => c.id === input.categoryId)) fail('分类不存在')
    input.tags = input.tags.filter((t) => d.tags?.some((x) => x.id === t))
    if (id === DEFAULT_AGENT_ID) Object.assign(input, { cli: '', model: '', effort: '', enabled: true })
    return method === 'POST' ? create('agents', input) : update('agents', id, input, 'Agent 不存在')
  }

  if (res === 'workflows') {
    if (method === 'GET') return d.workflows
    if (method === 'DELETE') {
      const err = workflowDeleteError(id, d.projectCategories, d.projects)
      if (err) fail(err)
      remove('workflows', id, '工作流不存在')
      return undefined
    }
    const wf = parse(WorkflowInput, body)
    wf.tags = wf.tags.filter((t) => d.tags?.some((x) => x.id === t))
    // 和服务端同一套检查：成员、连线、环、流程之间的循环调用
    const err = checkWorkflow(wf, new Set(d.agents.map((a) => a.id)), d.workflows, method === 'POST' ? '' : id)
    if (err) fail(err)
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

  // 引入会话：演示里只给一份假的附件（没有本机磁盘）
  if ((res === 'tasks' || res === 'designs') && sub === 'transcript' && method === 'POST') {
    const title =
      res === 'tasks'
        ? ((d.tasks ?? []).find((x) => x.id === id)?.title ?? fail('任务不存在'))
        : ((demoDesigns('GET', id, undefined, null) as { title: string }).title ?? fail('设计不存在'))
    const name = `会话-${title.slice(0, 40)}.md`
    return { name, path: `/demo/uploads/${crypto.randomUUID()}/${name}`, size: 4096, mime: 'text/markdown' }
  }
  if (res === 'designs' && id === 'styles') return demoStyles(method, sub, body ?? {})
  if (res === 'designs' && sub === 'extract-style') return demoExtractStyle(id)
  if (res === 'designs' && id === 'projects' && seg[3] === 'components') return demoProjectComponents(sub)
  if (res === 'designs' && sub === 'components') return demoImportComponent(id, body ?? {})
  if (res === 'designs' && sub === 'versions') return demoVersions(method, id, seg[3], seg[4], body ?? {})
  if (res === 'designs')
    // 演示里没有失败的图，重试和生成一样
    return seg[2] === 'images' && (seg[4] === 'generate' || seg[4] === 'retry')
      ? demoGenerate(id, seg[3], body ?? {})
      : demoDesigns(method, id, sub, body ?? {})
  if (res === 'tasks') return tasksRoute(method, id, sub, query, body, seg[3])
  // 演示里的 AI 不会请求确认，也不会提问
  if (res === 'asks') return method === 'GET' ? [] : { ok: true }

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
  if (url.startsWith('/app/')) return demoApp(url)
  const result = await route(method, url, body)
  // 返回副本：执行中的任务会被原地修改，页面需要拿到新对象才会刷新
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
}

// 让类型检查确认演示数据结构与真实 schema 一致
export const __schemas = { Agent, Category, Workflow, ProjectCategory, Project }

// ---- 任务 ----
const live = new Map<string, { stop: boolean; done?: Promise<unknown> }>()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function projectWorkflow(d: Db, p: Project) {
  const id = p.workflowId || d.projectCategories.find((c) => c.id === p.categoryId)?.workflowId
  return d.workflows.find((w) => w.id === id)
}

function startTurn(d: Db, task: Task, prompt: string, first: boolean, fast = false) {
  const entry: { stop: boolean; done?: Promise<unknown> } = { stop: false }
  live.set(task.id, entry)
  beginRun(task)
  let last = 0
  const done = runTurn({
    task,
    agents: d.agents,
    settings: d.settings,
    ...taskWorkflows(task, d.workflows),
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
    endRun(task)
    live.delete(task.id)
    persist()
    // 和正式版一样：这一轮完成后接着处理排队的要求
    const q = task.status === 'done' ? (task.queue ??= []).shift() : undefined
    if (q) void followUp(d, task, q.text, fast, q.attachments)
  })
  entry.done = done
  return done
}

function createTask(d: Db, input: NewTaskInput, fast = false) {
  // 没有项目的是 Chat 模式的聊天，只能直接对话
  if (!input.projectId && input.mode !== 'chat') fail('缺少项目')
  const project = input.projectId ? (d.projects.find((p) => p.id === input.projectId) ?? fail('项目不存在')) : undefined
  let workflow: Workflow | undefined
  if (input.mode === 'workflow' && project) {
    workflow = input.workflowId ? d.workflows.find((w) => w.id === input.workflowId) : projectWorkflow(d, project)
    if (!workflow) fail('项目还没有指定工作流，请选择一个工作流或改用直接对话')
  } else if (!d.agents.some((a) => a.id === input.agentId)) fail('请选择对话的 Agent')
  const lack = chatMissingParams(input, d.agents)
  if (lack) fail(lack)
  const task = create<Task>('tasks', {
    ...newTask(
      input,
      workflow,
      new Date().toISOString(),
      `demo-${crypto.randomUUID()}`,
      workflow ? workflowClosure(workflow, d.workflows) : [],
    ),
    simulated: true,
  })
  // 演示里没有真的仓库：只记下分支信息，让界面能展示合并 / 丢弃
  if (input.isolate && project)
    task.worktree = {
      path: '',
      branch: `agent-panel/${task.id.slice(5, 13)}`,
      baseBranch: 'main',
      state: 'active',
      note: '',
    }
  return { task, done: startTurn(d, task, withAttachments(input.prompt, input.attachments), true, fast) }
}

function followUp(d: Db, task: Task, text: string, fast = false, attachments: Attachment[] = []) {
  if (live.has(task.id)) fail('任务正在执行，请等它完成或先停止')
  task.messages.push({
    id: `demo-${crypto.randomUUID()}`,
    role: 'user',
    agentId: '',
    step: '',
    text,
    tools: [],
    ...(attachments.length ? { attachments } : {}),
    at: new Date().toISOString(),
  })
  return startTurn(d, task, withAttachments(text, attachments), false, fast)
}

function tasksRoute(
  method: string,
  id: string | undefined,
  sub: string | undefined,
  query: URLSearchParams,
  body: unknown,
  rid?: string,
) {
  const d = load()
  const tasks = (d.tasks ??= [])
  if (!id) {
    if (method === 'GET') {
      const pid = query.get('projectId')
      return (pid ? tasks.filter((t) => t.projectId === pid) : tasks).map(taskSummary)
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
  if (sub === 'queue' && method === 'DELETE') {
    task.queue = (task.queue ?? []).filter((q) => q.id !== rid)
    persist()
    return task
  }
  if (sub === 'rewind' || sub === 'fork') {
    if (live.has(id)) fail('任务正在执行，请等它完成或先停止')
    if (task.mode !== 'chat') fail('只有对话任务可以这样做')
    const { messageId } = (body ?? {}) as { messageId?: string }
    const i = task.messages.findIndex((m) => m.id === messageId && m.role === 'user' && !m.step)
    if (i < 0) fail('找不到这条消息')
    if (sub === 'rewind') {
      if (!task.messages.slice(0, i).some((m) => m.role === 'user')) fail('第一条消息不能撤回，可以新建一个对话')
      const removed = task.messages[i]
      task.messages = task.messages.slice(0, i)
      task.queue = []
      task.status = 'done'
      persist()
      return { task, text: removed.text, attachments: removed.attachments ?? [] }
    }
    const next = task.messages.findIndex((m, k) => k > i && m.role === 'user' && !m.step)
    const now = new Date().toISOString()
    const forked: Task = {
      ...JSON.parse(JSON.stringify(task)),
      id: `demo-${crypto.randomUUID()}`,
      title: `${task.title}（分叉）`.slice(0, 80),
      messages: task.messages
        .slice(0, next < 0 ? task.messages.length : next)
        .map((m) => ({ ...m, id: `demo-${crypto.randomUUID()}` })),
      status: 'done',
      queue: [],
      requests: [],
      todos: [],
      worktree: null,
      createdAt: now,
      updatedAt: now,
    }
    tasks.unshift(forked)
    persist()
    return forked
  }
  if (sub === 'compact' || sub === 'review') {
    if (live.has(id)) fail('任务正在执行，请等它完成或先停止')
    if (sub === 'compact') {
      if (task.mode !== 'chat') fail('只有对话任务可以这样做')
      const at = new Date().toISOString()
      task.messages.push(
        { id: `demo-${crypto.randomUUID()}`, role: 'system', agentId: '', step: '', text: '压缩上下文', tools: [], at },
        {
          id: `demo-${crypto.randomUUID()}`,
          role: 'system',
          agentId: '',
          step: '',
          text: '上下文已压缩：之前的对话换成了摘要，接着聊会从摘要继续',
          tools: [],
          at,
        },
      )
      persist()
      return task
    }
    const base = (body as { base?: string } | undefined)?.base
    void followUp(d, task, base ? `审查相对 ${base} 的改动` : '审查还没提交的改动')
    return task
  }
  if (sub === 'messages') {
    const f = parse(FollowUpInput, body)
    const cur = live.get(task.id)
    // 补充：演示的模拟执行不会真的读它，记进对话（工作流里记在正在跑的节点上）
    if (cur && f.steer) {
      const step =
        task.mode === 'workflow' ? (task.steps.find((s) => s.status === 'running' && !s.parentId)?.id ?? '') : ''
      task.messages.push({
        id: `demo-${crypto.randomUUID()}`,
        role: 'user',
        agentId: '',
        step,
        text: f.text,
        tools: [],
        ...(f.attachments.length ? { attachments: f.attachments } : {}),
        at: new Date().toISOString(),
      })
      persist()
      return task
    }
    if (cur && !f.interrupt) {
      ;(task.queue ??= []).push({
        id: `demo-${crypto.randomUUID()}`,
        text: f.text,
        attachments: f.attachments,
        at: new Date().toISOString(),
      })
      persist()
      return task
    }
    if (cur) {
      cur.stop = true
      void cur.done?.finally(() => followUp(d, task, f.text, false, f.attachments))
      return task
    }
    void followUp(d, task, f.text, false, f.attachments)
    return task
  }
  // 回答 Agent 的请求：去掉请求，记一条说明；模拟执行那边在等它消失
  if (sub === 'requests' && rid) {
    const req = (task.requests ??= []).find((r) => r.id === rid) ?? fail('这个请求已经结束了')
    const a = body as { allow: boolean; answer?: string; answers?: string[] }
    simAnswers.set(rid, a)
    task.requests = task.requests.filter((r) => r.id !== rid)
    const answers = req.kind === 'question' ? questionAnswers(req, a) : undefined
    task.messages.push({
      id: `demo-${crypto.randomUUID()}`,
      role: 'system',
      agentId: req.agentId,
      step: req.step,
      text:
        req.kind === 'confirm'
          ? a.allow
            ? `你确认了「${task.steps.find((s) => s.id === req.step)?.title ?? ''}」的结果，接着往下执行`
            : `你退回了「${task.steps.find((s) => s.id === req.step)?.title ?? ''}」：${a.answer ?? ''}`
          : req.kind === 'question'
            ? `你回答了「${req.title}」：${(a.answers ?? [a.answer ?? '']).join('；')}`
            : `你${a.allow ? '允许' : '拒绝'}了：${req.title}`,
      tools: [],
      at: new Date().toISOString(),
      ...(answers ? { answers } : {}),
    })
    persist()
    return task
  }
  if (sub === 'worktree' && task.worktree) {
    if (live.has(task.id)) fail('任务正在执行，等它停下后再处理独立分支')
    const merge = rid === 'merge'
    task.worktree = { ...task.worktree, state: merge ? 'merged' : 'discarded', note: merge ? 'main' : '' }
    persist()
    return task
  }
  // 演示里没有真的项目目录，看不到文件内容
  if (sub === 'file')
    return { path: query.get('path') ?? '', dir: '', exists: false, content: '', truncated: false, demo: true }
  // 演示里没有真的目录：差异用 Agent 修改文件时给出的改动拼出来，不能撤销
  if (sub === 'diff') {
    const file = query.get('path') ?? ''
    const diff = task.messages
      .flatMap((m) => m.tools)
      .filter((x) => x.kind === 'edit' && x.label === file && x.input)
      .map((x) => x.input)
      .join('\n')
    return { path: file, dir: '', diff, git: false, before: false }
  }
  if (sub === 'resume') {
    if (live.has(task.id)) fail('任务正在执行')
    if (task.status !== 'failed' && task.status !== 'stopped') fail('只有失败或停止的任务可以继续')
    if ((body as { latest?: boolean } | undefined)?.latest && task.workflowId) {
      const fresh =
        d.workflows.find((w) => w.id === task.workflowId) ?? fail('工作流已经被删除，只能按任务创建时的工作流继续')
      task.workflows = workflowClosure(fresh, d.workflows)
      task.workflowName = fresh.name
    }
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    void startTurn(d, task, users.at(-1)?.text ?? '', false)
    return task
  }
  if (method === 'PATCH') {
    Object.assign(task, parse(TaskPatch, body))
    persist()
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
    // 示例任务是瞬间跑完的，给一个像样的执行时长
    if (t.status !== 'running') t.runMs = (2 + (minutes % 7)) * 60_000 + 23_000
  }
  if (admin) {
    const { task, done } = createTask(
      d,
      {
        projectId: admin.id,
        mode: 'workflow',
        workflowId: '',
        agentId: '',
        prompt: '订单导出 Excel 时，日期列整体往右错了一列',
        attachments: [],
        cli: '',
        model: '',
        effort: '',
        isolate: false,
        askUser: false,
        params: {},
      },
      true,
    )
    await done
    back(task, 60 * 26)
  }
  if (shop && fe) {
    const { task, done } = createTask(
      d,
      {
        projectId: shop.id,
        mode: 'chat',
        workflowId: '',
        agentId: fe.id,
        prompt: '购物车右上角的数量角标偶尔不刷新，帮我看看原因',
        attachments: [],
        cli: '',
        model: '',
        effort: '',
        isolate: false,
        askUser: false,
        params: {},
      },
      true,
    )
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
        attachments: [],
        cli: '',
        model: '',
        effort: '',
        isolate: false,
        askUser: false,
        params: {},
      },
      true,
    )
    await done
    await followUp(d, task, '按钮文案改成「到货通知我」，已经登记过的用户显示「已登记」并置灰。', true)
    back(task, 25)
  }
}

/**
 * 版本更新：在线演示直接从浏览器读 GitHub Releases（接口允许跨域），当作最新发布的版本；不能安装。
 */
async function demoApp(url: string): Promise<unknown> {
  if (url.startsWith('/app/install') || url.startsWith('/app/rollback')) fail('在线演示不能安装，可以下载包到本机运行')
  let list: AppRelease[] = []
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`)
    list = ((await res.json()) as any[])
      .filter((r) => !r.draft)
      .map((r) => {
        const asset = (ext: string) => (r.assets ?? []).find((a: any) => String(a.name).endsWith(ext))
        return {
          tag: r.tag_name,
          version: String(r.tag_name).replace(/^v/, ''),
          prerelease: !!r.prerelease,
          publishedAt: r.published_at ?? '',
          notes: r.body ?? '',
          url: r.html_url ?? '',
          tarUrl: asset('.tar.gz')?.browser_download_url ?? '',
          zipUrl: asset('.zip')?.browser_download_url ?? '',
          size: asset('.tar.gz')?.size ?? 0,
        }
      })
      .filter((r) => r.tarUrl)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  } catch (e) {
    return {
      current: '',
      packaged: false,
      releases: [],
      error: `检查更新失败：${(e as Error).message}`,
    } satisfies AppReleases
  }
  const current = list[0]?.version ?? ''
  if (url.startsWith('/app/version')) return { current, packaged: false }
  return {
    current,
    packaged: false,
    releases: list.slice(0, 5),
    update: pickUpdate(current, list),
  } satisfies AppReleases
}
