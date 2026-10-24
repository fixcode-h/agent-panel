/**
 * 在线演示版的「后端」：在浏览器里实现和 server/index.ts 相同的接口，数据存在 localStorage。
 * 只在 VITE_DEMO 构建中使用；本机版本走真正的 Node 服务。
 */
import { demoAccounts } from './demo-accounts'
import { demoIntegrations } from './demo-integrations'
import { demoLibrary, demoPanelCommands } from './demo-library'
import {
  projectSkillRepos,
  skillIssues,
  skillTemplate,
  type ProjectSkill,
  type ProjectSkillsView,
} from '@shared/project-skills'
import { z } from 'zod'
import {
  Agent,
  LEGACY_DEFAULT_AGENT_ID,
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
  GlobalLesson,
  GlobalLessons,
  ProjectLesson,
  Workflow,
  WorkflowInput,
  type Flow,
  type FlowNode,
  FollowUpInput,
  TaskPatch,
  NewTaskInput,
  Settings,
  type PlanStatus,
  type Task,
  type TaskMessage,
  type TaskProcess,
  type TaskProcesses,
  type TaskMemoryHistory,
  type TaskMemoryAnalysis,
  type TaskStep,
  type TaskTurn,
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
import { DATA_KINDS, type DataKind, type MemoryUsage } from '@shared/data'
import { UsageQuery, usageReport } from '@shared/usage'
import { runTree, runUsage } from '@shared/run-usage'
import {
  TASK_MEMORY_ASK,
  clipReport,
  ownersOf,
  taskMemoryReport,
  taskMemoryTrend,
  taskTrendText,
} from '@shared/memory-analysis'
import { descendantTotals } from '@shared/task-export'
import { newLessonId, upsertLesson } from '@shared/lessons'
import { orderProjects, projectOrderError, sortProjects } from '@shared/project-order'
import { REPO, pickUpdate, type AppRelease, type AppReleases, type InterruptedTasks } from '@shared/version'
import { CLIS, getCli } from '@shared/clis'
import { BUILTIN_MODEL_CATALOG } from '@shared/model-catalog'
import {
  BUILTIN_WORKFLOWS,
  ComfyWorkflow,
  comfyImportFile,
  LOCAL_FILES,
  LOCAL_MODELS,
  localModel,
  localFile,
  localWorkflow,
  modelReady,
  type LocalJob,
  type LocalStatus,
} from '@shared/local-image'
import {
  builtinTemplates,
  builtinTemplateMeta,
  type ComfyTemplateMeta,
  type TemplateAsset,
} from '@shared/comfy-templates'
import { defaultCli, orderClis } from '@shared/settings'
import { runTurn, simAnswers } from '@shared/runner'
import { stopHelper } from '@shared/engine'
import { chatMissingParams, cycleText, includeCycle } from '@shared/agent-role'
import {
  beginRun,
  childActivity,
  childLastActivity,
  childStartedAt,
  childWait,
  closeFlow,
  dropEndNotes,
  endRun,
  helpersWorking,
  newTask,
  questionAnswers,
  runRunning,
  taskSummary,
  trackWait,
  withAttachments,
} from '@shared/task'
import { openPlan } from '@shared/plan'
import { END, START, autoLayout, blockedStep, edge, newFlow, newNode, taskFlow, taskWorkflows } from '@shared/flow'
import { DEFAULT_WORKFLOW_ID, defaultWorkflow, taskSnapshot } from '@shared/builtin/default'
import { CORE_AGENTS, coreDefinition, coreKey, isCoreAgent, syncCore } from '@shared/builtin/core'
import { BUILTIN_AGENTS, CORE_CATEGORY } from '@shared/builtin/agents'
import { builtinProjectCategories, projectCategoryDeleteError } from '@shared/builtin/project-categories'
import { importTaskTree, parseTaskExport, exportTaskTree, checkExportSize } from '@shared/task-export'
import { AssistInput } from '@shared/assist'
import { demoAssistJob, startDemoAssist, stopDemoAssist } from './demo-assist'
import { demoFixStart } from './demo-fix'
import { demoDocJob, demoDocs, saveDemoDoc, startDemoDocJob, stopDemoDocJob } from './demo-docs'
import { demoDeploy } from './demo-deploy'
import { demoProjectMcp } from './demo-project-mcp'
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
import { demoMs } from './demo-speed'

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
  /** 全局教训；旧版本的演示数据没有这一项 */
  globalLessons?: GlobalLesson[]
}

/** 演示里的全局教训：一条从别的项目提取来的 */
const DEMO_GLOBAL_LESSONS: GlobalLesson[] = [
  {
    id: 'demo-global-1',
    title: '改了提示词或界面文案，先搜测试里有没有断言原句',
    rule: '提交前在测试目录里搜一下改动前的原句，断言了的一起改；改完跑一遍相关测试。',
    cause: '几次改了提示词，测试还在断言旧写法，提交后才发现。',
    paths: [],
    enabled: true,
    from: ['运营后台'],
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '',
  },
]

class HttpError extends Error {
  constructor(
    message: string,
    /** 状态码：正式后端用 409 表示「现在不能做」，界面按它区分提示（见 api.ts 的 err.status） */
    readonly status = 400,
  ) {
    super(message)
  }
}
const fail = (msg: string, status = 400): never => {
  throw new HttpError(msg, status)
}

// ---- 模拟的本机目录 ----
const HOME = '/home/demo'
// init：目录里已有 AI 初始化写好的 AGENTS.md 和文档框架（还没建项目），新建项目时不用再初始化
const TREE: Record<string, { git?: string; branches?: string[]; init?: boolean }> = {
  '/home/demo': {},
  '/home/demo/code': {},
  '/home/demo/code/web-shop': { git: 'main', branches: ['main', 'feat/checkout', 'fix/cart-total'] },
  '/home/demo/code/web-shop/src': {},
  '/home/demo/code/web-shop/tests': {},
  '/home/demo/code/admin-console': { git: 'develop', branches: ['develop', 'main', 'release/2.0'] },
  '/home/demo/code/admin-console/src': {},
  '/home/demo/code/game-client': { git: 'release/1.2', branches: ['release/1.2', 'develop', 'main'] },
  '/home/demo/code/game-client/Source': {},
  '/home/demo/code/game-client/Content': {},
  '/home/demo/code/notes': {},
  '/home/demo/code/lua-helper': { git: 'main', init: true },
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
  return { path, exists: !!node, isDir: !!node, gitBranch: node?.git ?? null, initialized: !!node?.init }
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
    // 测试与验收这类通用 Agent 的参数：项目设置里按它派生配置项
    params: [
      {
        key: 'scope',
        label: '范围',
        type: 'select',
        options: ['本次改动', '整体'],
        default: '本次改动',
        ask: false,
        description: '',
      },
      {
        key: 'env',
        label: '环境',
        type: 'select',
        options: ['自动', 'wsl', 'powershell', 'bash'],
        default: '自动',
        ask: false,
        description: '',
      },
      { key: 'regress', label: '查回归', type: 'bool', default: true, options: [], ask: false, description: '' },
    ],
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
    expose: [],
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
    expose: [],
  }
  // 演示数据和正式后端用同一组内置分类（shared/builtin/project-categories.ts）；
  // 第一个分类在演示里绑上示例工作流，让示例项目有默认工作流（正式安装里由用户自己指定）
  const builtinCats = builtinProjectCategories()
  const web: ProjectCategory = { ...builtinCats[0], workflowId: webFlow.id }
  const game: ProjectCategory = builtinCats[1]
  // 演示项目的添加时间各不相同：侧栏默认就按它排，和真实的项目列表一致
  const project = (
    o: Pick<ProjectInput, 'name' | 'description' | 'path' | 'categoryId' | 'workflowId'> & Partial<ProjectInput>,
    createdAt: string,
  ): Project => ({
    ...meta(),
    createdAt,
    agentParams: {},
    childIsolation: 'worktree',
    isolateDefault: false,
    scaledVerify: true,
    workflowIds: [],
    defaultAgentId: '',
    agentSet: true,
    workflowParams: {},
    testSteps: [],
    lessons: [],
    wslDistro: '',
    gitPolicy: 'ask',
    // 演示项目都当作已经初始化过，打开设置能直接保存；「重新初始化」可以看推荐的样子
    initializedAt: createdAt,
    ...o,
  })
  return {
    categories: [plan, dev, qa, wfDev, wfFix],
    tags: [tWeb, tQuality, tCommon],
    agents: [arch, fe, be, qaAgent, review, docs],
    workflows: [webFlow, bugFlow],
    projectCategories: [web, ...builtinCats.slice(1)],
    projects: [
      project(
        {
          name: '商城前台',
          description: '面向用户的商城网站',
          path: '/home/demo/code/web-shop',
          categoryId: web.id,
          workflowId: '',
          // 演示里的测试步骤：项目设置里能看到增删、排序和启停
          testSteps: [
            {
              id: 'demo-typecheck',
              name: '类型检查',
              command: 'npm run typecheck',
              env: 'auto',
              cwd: '',
              when: '',
              // 演示里展示「适用改动」：只改文档时这一步会被跳过
              appliesTo: ['**/*.ts', '**/*.tsx', '**/package.json'],
              timeoutSec: 0,
              note: '',
              enabled: true,
              merge: true,
              quick: true,
            },
            {
              id: 'demo-e2e',
              name: '端到端测试',
              command: 'npm run test:e2e',
              env: 'wsl',
              cwd: '',
              when: '仅发布前跑',
              appliesTo: ['**/*.ts', '**/*.tsx', 'src/**'],
              timeoutSec: 600,
              note: '在 WSL 里执行，不要在 PowerShell 里直接跑',
              enabled: true,
              merge: false,
              quick: false,
            },
          ],
          wslDistro: 'Ubuntu-24.04',
          // 演示里的项目教训：一条手动记的全局规则，两条 Agent 被纠正后记的按文件生效
          lessons: [
            {
              id: 'demo-lesson-1',
              title: '价格一律用分（整数）存和算，只在显示时转成元',
              rule: '接口、数据库、购物车计算都用整数分；格式化统一走 src/utils/money.ts 的 formatPrice，不要在组件里自己除以 100。',
              cause: '结算页用浮点数相加，0.1 + 0.2 显示成 0.30000000000000004 元。',
              paths: [],
              tags: ['金额'],
              enabled: true,
              source: 'user',
              taskId: '',
              createdAt: '2026-09-05T10:00:00.000Z',
              updatedAt: '',
              history: [],
            },
            {
              id: 'demo-lesson-2',
              title: '新增支付方式写进 payment/providers 的配置，不在下单流程里按名字判断',
              rule: '每种支付方式一份 provider 配置（图标、限额、是否支持分期、是否显示优惠角标）；下单、退款代码只读配置字段，不写 if (method === "alipay") 这类分支。活动期间的临时规则也写进配置的 promo 字段，带上结束时间。',
              cause: '加微信支付时分期开关写死在下单流程里，后来接 PayPal 又改了一遍。',
              paths: ['src/payment/**', 'src/pages/checkout/**'],
              tags: ['支付', '配置'],
              enabled: true,
              source: 'agent',
              taskId: '',
              createdAt: '2026-09-12T15:30:00.000Z',
              updatedAt: '2026-09-20T09:10:00.000Z',
              history: [
                {
                  title: '新增支付方式写进 payment/providers 的配置，不在下单流程里按名字判断',
                  rule: '每种支付方式一份 provider 配置（图标、限额、是否支持分期）；下单、退款代码只读配置字段，不写 if (method === "alipay") 这类分支。',
                  why: '用户要求双十一期间只给支付宝显示「立减」角标，和「不按名字判断」冲突；两全的做法是把活动规则写进配置的 promo 字段。',
                  at: '2026-09-20T09:10:00.000Z',
                },
              ],
            },
            {
              id: 'demo-lesson-3',
              title: '改接口字段时同步改 mock 数据和类型',
              rule: 'src/api/types.ts 改了，mock/ 下对应的 JSON 一起改，否则本地开发和 e2e 用的还是旧结构。',
              cause: '订单接口加了 couponId，mock 没跟上，e2e 一直测的旧结构。',
              paths: ['src/api/**', 'mock/**'],
              tags: ['接口', '测试'],
              enabled: true,
              source: 'agent',
              taskId: '',
              createdAt: '2026-09-18T11:20:00.000Z',
              updatedAt: '',
              history: [],
            },
            {
              id: 'demo-lesson-4',
              title: '后台命令报完成后先看用时，明显不对就查原因再换做法',
              rule: '定时、轮询、等构建这类要等的事交给 run_background；结果回来先核对用时和输出，比如一小时的倒计时 0 秒就「成功」，说明命令没按预期运行，先查清楚再换做法，不要直接当作完成。',
              cause: '设一小时倒计时，脚本 0 秒就被判定完成，换成面板的长驻任务才对。',
              paths: [],
              tags: ['命令行'],
              enabled: true,
              source: 'agent',
              taskId: '',
              createdAt: '2026-09-22T08:45:00.000Z',
              updatedAt: '',
              history: [],
            },
          ],
        },
        '2026-09-02T09:00:00.000Z',
      ),
      project(
        {
          name: '运营后台',
          description: '内部运营管理系统',
          path: '/home/demo/code/admin-console',
          categoryId: web.id,
          workflowId: bugFlow.id,
        },
        '2026-09-20T09:00:00.000Z',
      ),
      project(
        {
          name: '客户端主工程',
          description: '',
          path: '/home/demo/code/game-client',
          categoryId: game.id,
          workflowId: '',
        },
        '2026-10-03T09:00:00.000Z',
      ),
      project(
        {
          name: '旧官网',
          description: '已经下线的旧站点',
          path: '/home/demo/code/old-site',
          categoryId: '',
          workflowId: '',
        },
        '2026-10-12T09:00:00.000Z',
      ),
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
  db.projects = db.projects.map((p) => Project.parse(p))
  db.tags ??= []
  db.globalLessons ??= DEMO_GLOBAL_LESSONS
  db.projectCategories = (db.projectCategories ?? []).map((c) => ProjectCategory.parse(c))
  // 和正式后端一样：缺哪个内置分类就补哪个（按固定 id，不动用户自建的，也不重复插入）
  const missingCats = builtinProjectCategories().filter((b) => !db!.projectCategories.some((c) => c.id === b.id))
  if (missingCats.length) db.projectCategories = [...missingCats, ...db.projectCategories]
  // 以前自带的默认 Agent 已经去掉（不用角色就是直接用 CLI），旧的演示数据里还有时删掉
  db.agents = db.agents.filter((a) => a.id !== LEGACY_DEFAULT_AGENT_ID)
  if (!db.workflows.some((w) => w.id === DEFAULT_WORKFLOW_ID)) db.workflows.unshift(defaultWorkflow())
  ensureDemoCore(db)
  return db
}

/** 和服务端启动时一样：必备角色（和它们引入的「通用约束」）缺了就补上，已有的按内置定义同步 */
function ensureDemoCore(d: Db) {
  const at = new Date(0).toISOString()
  let cat = d.categories.find((c) => c.scope === 'agent' && c.name === CORE_CATEGORY)
  if (!cat) {
    cat = { id: 'demo-core', name: CORE_CATEGORY, scope: 'agent', createdAt: at, updatedAt: at }
    d.categories.push(cat)
  }
  for (const key of ['rules', ...CORE_AGENTS.map((c) => c.key)]) {
    if (d.agents.some((a) => a.origin === `builtin:${key}`)) continue
    const def = BUILTIN_AGENTS.find((b) => b.key === key)!
    d.agents.push({
      ...AgentInput.parse({ ...def.agent, origin: `builtin:${key}`, categoryId: key === 'rules' ? '' : cat.id }),
      id: `demo-${key}`,
      createdAt: at,
      updatedAt: at,
    })
  }
  const rules = d.agents.find((a) => a.origin === 'builtin:rules')
  d.agents = d.agents.map((a) => {
    const key = coreKey(a)
    if (!key) return a
    const def = coreDefinition(key)
    const includes = def.includes.map((k) => (k === 'rules' ? (rules?.id ?? '') : '')).filter(Boolean)
    return { ...a, ...syncCore(a, def, { categoryId: cat.id, includes }), name: a.name || def.agent.name }
  })
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

/**
 * 在线演示的内存采样：按 30 秒一个点，模拟最近两小时（真机是服务端定时采样，这里是演示数据）。
 * 两小时是因为曲线默认只显示一小时，右键拖动往前看时得还有更早的点，否则演示里拖不动。
 * 用时间算，不存随机值：同一时刻刷新曲线是稳定的，过一会儿再看才会动——和真机的采样一样能看到起伏。
 */
function demoDataMemory(d: Db, now = Date.now()): MemoryUsage {
  const INTERVAL_MS = 30_000
  // 和真机一样保留两小时的点：曲线默认看一小时，右键拖动才有的往前看
  const COUNT = 240
  const last = Math.floor(now / INTERVAL_MS)
  const tasks = d.tasks ?? []
  const running = tasks.filter((x) => x.status === 'running').length
  const MB = 1024 * 1024
  // 「进程」这一路：运行中的任务各占一份 CLI；演示数据里没有运行中的任务时模拟一个，
  // 否则第二路永远是 0，看不出两路曲线的设计（真机上没有子进程时是真实的 0，界面显示「没有子进程」）
  const cliProcesses = running || 1
  const samples = Array.from({ length: COUNT }, (_, i) => {
    const k = last - (COUNT - 1 - i)
    const wave = Math.sin(k / 6) * 5 + Math.sin(k / 17) * 8
    const rss = Math.round((108 + wave + (i / COUNT) * 22) * MB)
    const heapUsed = Math.round((76 + wave * 0.8 + (i / COUNT) * 14) * MB)
    const child = Math.round((cliProcesses * 96 + Math.sin(k / 4) * 18 + (i / COUNT) * 60) * MB)
    return {
      at: new Date(k * INTERVAL_MS).toISOString(),
      rss,
      heapTotal: 128 * MB,
      heapUsed,
      external: Math.round((4 + Math.sin(k / 9) * 1.5) * MB),
      arrayBuffers: Math.round((2 + Math.sin(k / 11) * 0.8) * MB),
      running,
      child,
    }
  })
  const memory = samples[samples.length - 1]
  return {
    memory,
    samples,
    sampling: { intervalMs: INTERVAL_MS, keepMs: 2 * 60 * 60_000 },
    uptimeMs: 2 * 60 * 60_000 + 12 * 60_000,
    child: { processes: cliProcesses, bytes: memory.child },
    scale: {
      tasks: tasks.length,
      chats: tasks.filter((x) => x.mode === 'chat').length,
      projects: d.projects.length,
      running,
    },
  }
}

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
    return { dir: '~/.agent-panel（在线演示，数据存在浏览器里）', kinds, ...demoDataMemory(d) }
  }
  // 内存曲线按采样间隔刷新：演示版也返回同样的结构，曲线和「AI 分析」都能试
  if (action === 'memory' && method === 'GET') return demoDataMemory(d)
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
  gemini: '0.40.0',
  pi: '1.3.0',
}
// npm 上的「最新版本」：Claude Code 演示有更新可装
const LATEST: Record<string, string> = {
  claude: '2.1.301',
  codex: '0.150.0',
  commandcode: '1.8.2',
  gemini: '0.40.0',
  pi: '1.3.0',
}

/** 启用的 CLI：演示里也是停用的不出现在部署、技能库这些地方 */
function activeClis(): string[] {
  const s = load().settings
  return CLIS.filter((c) => s?.clis[c.id]?.enabled ?? true).map((c) => c.id)
}

function clis(): CliStatus[] {
  const d = load()
  const s = d.settings
  return orderClis(
    CLIS.map((c) => {
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
    }),
    s?.cliOrder ?? [],
    (c) => c.enabled,
  )
}

// 模拟安装 / 卸载：几秒内逐行输出，然后切换安装状态
const installJobs = new Map<string, CliInstallJob>()
function cliAction(id: string, action: CliInstallJob['action']) {
  const def = getCli(id) ?? fail('未知的 Agent')
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
      : id === 'pi'
        ? // Pi 演示卸载没成功的样子（npm 删掉了包，启动脚本还在），可以试「AI 处理」
          ['（在线演示：模拟卸载，不会真的执行 npm）', '', 'up to date in 364ms']
        : ['（在线演示：模拟卸载，不会真的执行 npm）', '', 'removed 3 packages in 1s']
  lines.forEach((l, i) =>
    setTimeout(
      () => {
        job.log += l + '\n'
        if (i < lines.length - 1) return
        if (id === 'pi' && action === 'uninstall') {
          job.status = 'failed'
          job.error =
            '已经执行了卸载，但还能找到 C:\\Users\\demo\\AppData\\Roaming\\npm\\pi.cmd。它不是 npm 、Homebrew 或官方安装脚本装的，请手动删除这个文件，或用安装它的方式卸载。'
          return
        }
        const d = load()
        d.installed = { ...d.installed, [id]: action === 'install' }
        if (action === 'install') VERSIONS[id] = VERSIONS[id].replace(/\d+\.\d+\.\d+/, LATEST[id])
        persist()
        job.cliStatus = clis().find((c) => c.id === id)
        job.status = 'done'
      },
      demoMs(500 * (i + 1)),
    ),
  )
  return job
}

/** 演示上传的附件内容（data URL），刷新页面后就没了 */
export const demoUploads = new Map<string, string>()

/** 演示附件的文字内容（data: 地址解出来）；不是文字或不在了给 null */
function demoUploadText(p: string): string | null {
  const url = demoUploads.get(p)
  if (!url) return null
  const [head, data = ''] = url.split(',')
  if (!/^data:(text\/|application\/(json|javascript|xml))/.test(head) && !/\.(md|txt|json|ts|js|css|html)$/i.test(p))
    return null
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

/** 演示里认回粘贴的路径：引用卡片的原文文件认回成引用 */
function demoResolve(paths: string[]): (Attachment & { from: string })[] {
  return paths.flatMap((from) => {
    const url = demoUploads.get(from)
    if (!url) return []
    const base = from.split('/').pop() ?? from
    const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? ''
    const size = Math.floor(((url.split(',')[1] ?? '').length * 3) / 4)
    const q = /^quote-(q[0-9a-z]+)\.md$/.exec(base)
    const text = q ? demoUploadText(from) : null
    if (q && text !== null) {
      const flat = text.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim()
      const name = `${flat.length > 40 ? `${flat.slice(0, 40)}…` : flat}#${q[1]}`
      return [{ from, name, path: from, size, mime: 'text/markdown', quote: text, ref: true }]
    }
    return [{ from, name: base, path: from, size, mime, ref: true }]
  })
}

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

/** 演示里几个文件有内容，其余只显示路径 */
const DEMO_CONTENTS: Record<string, string> = {
  'README.md': '# 示例商店\n\n演示用的前端项目，故意留了几处没改完的地方。\n',
  'src/App.tsx':
    "import { Routes, Route } from 'react-router-dom'\nimport { Login } from './pages/Login'\nimport { ProductDetail } from './pages/ProductDetail'\nimport { OrderList } from './pages/OrderList'\n\nexport function App() {\n  return (\n    <Routes>\n      <Route path=\"/login\" element={<Login />} />\n      <Route path=\"/products/:id\" element={<ProductDetail />} />\n      <Route path=\"/orders\" element={<OrderList />} />\n    </Routes>\n  )\n}\n",
  'src/api/cart.ts':
    "const BASE = '/api/cart'\n\nexport async function addToCart(productId: string, count: number) {\n  const res = await fetch(BASE, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ productId, count }),\n  })\n  if (!res.ok) throw new Error('加入购物车失败')\n  return res.json()\n}\n\nexport async function removeFromCart(id: string) {\n  await fetch(`${BASE}/${id}`, { method: 'DELETE' })\n}\n",
  'src/components/ProductCard.tsx':
    'import { Link } from \'react-router-dom\'\n\nexport function ProductCard({ product }: { product: { id: string; name: string; price: number } }) {\n  return (\n    <Link to={`/products/${product.id}`} className="block rounded-xl border p-4">\n      <div className="font-medium">{product.name}</div>\n      <div className="text-sm text-muted">￥{product.price.toFixed(2)}</div>\n    </Link>\n  )\n}\n',
  'src/store/cart.ts':
    "import { addToCart } from '../api/cart'\n\ntype Item = { productId: string; count: number }\n\nlet items: Item[] = []\n\nexport const cart = {\n  get items() {\n    return items\n  },\n  async add(productId: string, count = 1) {\n    await addToCart(productId, count)\n    const hit = items.find((i) => i.productId === productId)\n    if (hit) hit.count += count\n    else items = [...items, { productId, count }]\n  },\n}\n",
  'package.json':
    '{\n  "name": "demo-shop",\n  "private": true,\n  "scripts": { "dev": "vite", "test": "vitest" },\n  "dependencies": { "react": "^19.0.0", "react-router-dom": "^7.0.0" },\n  "devDependencies": { "vite": "^6.0.0", "vitest": "^3.0.0" }\n}\n',
}

/** 演示里故意标出的改动：让文件树上的 git 状态有东西可看 */
const DEMO_STATUS: Record<string, string> = {
  'src/api/cart.ts': 'M',
  'src/store/cart.ts': 'M',
  'src/components/CartBadge.tsx': 'A',
  'src/pages/OrderList.tsx': '?',
  'tests/cart.test.ts': 'D',
}

/**
 * 示例对话改过的两个文件：差异窗口要有真实的 hunk、删除、新增和行内改动可看。
 * 演示里没有仓库，这些文本直接当任务的差异返回（见 demoTask 的 diff 分支）。
 */
const DEMO_DIFFS: Record<string, string> = {
  'src/components/CartBadge.tsx': [
    'diff --git a/src/components/CartBadge.tsx b/src/components/CartBadge.tsx',
    'index 3c1a2f0..8d4b7c1 100644',
    '--- a/src/components/CartBadge.tsx',
    '+++ b/src/components/CartBadge.tsx',
    '@@ -1,11 +1,13 @@',
    " import { useEffect, useState } from 'react'",
    "+import { useCart } from '../store/cart'",
    ' ',
    ' export function CartBadge() {',
    '-  const [count, setCount] = useState(0)',
    '+  const items = useCart()',
    '+  const count = items.reduce((n, item) => n + item.count, 0)',
    ' ',
    '   useEffect(() => {',
    "-    fetch('/api/cart').then((r) => r.json()).then((d) => setCount(d.length))",
    '-  }, [])',
    "+    document.title = count > 0 ? `购物车 (${count})` : '商城'",
    '+  }, [count])',
    ' ',
    '   return <span className="badge">{count}</span>',
    ' }',
  ].join('\n'),
  'src/components/RestockButton.tsx': [
    'diff --git a/src/components/RestockButton.tsx b/src/components/RestockButton.tsx',
    'new file mode 100644',
    'index 0000000..4b825dc',
    '--- /dev/null',
    '+++ b/src/components/RestockButton.tsx',
    '@@ -0,0 +1,9 @@',
    "+import { useState } from 'react'",
    '+',
    '+export function RestockButton({ productId }: { productId: string }) {',
    '+  const [sent, setSent] = useState(false)',
    '+  if (sent) return <button disabled>已登记</button>',
    '+  return (',
    '+    <button onClick={() => setSent(true)}>到货通知我</button>',
    '+  )',
    '+}',
  ].join('\n'),
}

/** 在线演示里文件页的写操作：新建的目录记在这里，改过的内容直接在 DEMO_CONTENTS 上改，刷新就回到初始状态 */
const DEMO_DIRS = new Set<string>()

/** 演示的名字校验：和正式版一样只收单段名字 */
function demoOneName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n === '.' || n === '..' || /[\\/]/.test(n) || /^[a-zA-Z]:/.test(n))
    fail('名字只能是单个文件名，不能带路径分隔符或 ..')
  return n
}

const demoExists = (p: string) =>
  DEMO_FILES.includes(p) || p in DEMO_CONTENTS || DEMO_DIRS.has(p) || DEMO_FILES.some((f) => f.startsWith(`${p}/`))
const demoSize = (text: string) => new TextEncoder().encode(text).length
/** 目录里的一项和它下面的全部内容（目录改名、删除时一起挪） */
const demoUnder = (from: string) => (p: string) => p === from || p.startsWith(`${from}/`)

/** 演示的项目文件：根信息、按层读取、按名称或内容搜索 */
function demoProjectLevel(files: string[], dirs: Set<string>, status: Record<string, string>, dir: string) {
  const levels = (path: string) => {
    // 界面检查靠它确认「展开才读这一层、收起再展开不重复读」；只在演示包里存在
    ;((globalThis as { __fileCalls?: string[] }).__fileCalls ??= []).push(path)
    const prefix = path ? `${path}/` : ''
    const seen = new Set<string>()
    const entries: { name: string; path: string; kind: 'dir' | 'file'; status: string }[] = []
    // 新建的空目录没有任何文件，得单独列出来
    for (const d of dirs) {
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (!rest || rest.includes('/') || seen.has(rest)) continue
      seen.add(rest)
      entries.push({ name: rest, path: d, kind: 'dir', status: '' })
    }
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const cut = rest.indexOf('/')
      const name = cut < 0 ? rest : rest.slice(0, cut)
      if (seen.has(name)) continue
      seen.add(name)
      const p = path ? `${path}/${name}` : name
      entries.push({
        name,
        path: p,
        kind: cut < 0 ? 'file' : 'dir',
        status: cut < 0 ? (status[f] ?? '') : '',
      })
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    return { dir, path, entries }
  }
  return levels
}

/** 演示的项目文件：根信息、按层读取、按名称或内容搜索，以及编辑工具条上的写操作 */
function demoProjectFiles(
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): unknown {
  const [id, kind] = seg.slice(1)
  const p = load().projects.find((x) => x.id === id) ?? fail('项目不存在')
  const dir = p.path || '~/demo/shop'
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const base = text(body.dir).replace(/^\/+|\/+$/g, '')
  if (method === 'PUT' && kind === 'content') {
    const want = text(body.path)
    if (!DEMO_FILES.includes(want)) fail('文件已经不在了')
    DEMO_CONTENTS[want] = text(body.content)
    return { path: want, size: demoSize(DEMO_CONTENTS[want]) }
  }
  if (method === 'POST' && kind === 'new') {
    const full = base ? `${base}/${demoOneName(body.name)}` : demoOneName(body.name)
    if (demoExists(full)) fail('已经有一个同名的文件或目录了')
    DEMO_FILES.push(full)
    DEMO_CONTENTS[full] = text(body.content)
    return { path: full, size: demoSize(DEMO_CONTENTS[full]) }
  }
  if (method === 'POST' && kind === 'mkdir') {
    const full = base ? `${base}/${demoOneName(body.name)}` : demoOneName(body.name)
    if (demoExists(full)) fail('已经有一个同名的文件或目录了')
    DEMO_DIRS.add(full)
    return { path: full }
  }
  if (method === 'POST' && kind === 'rename') {
    const from = text(body.path)
    if (!demoExists(from)) fail('文件已经不在了')
    const cut = from.lastIndexOf('/')
    const target = cut < 0 ? demoOneName(body.name) : `${from.slice(0, cut + 1)}${demoOneName(body.name)}`
    if (demoExists(target)) fail('已经有一个同名的文件或目录了')
    const under = demoUnder(from)
    for (let i = 0; i < DEMO_FILES.length; i++)
      if (under(DEMO_FILES[i])) DEMO_FILES[i] = `${target}${DEMO_FILES[i].slice(from.length)}`
    for (const k of Object.keys(DEMO_CONTENTS)) {
      if (!under(k)) continue
      DEMO_CONTENTS[`${target}${k.slice(from.length)}`] = DEMO_CONTENTS[k]
      delete DEMO_CONTENTS[k]
    }
    if (DEMO_DIRS.delete(from)) DEMO_DIRS.add(target)
    return { path: target }
  }
  if (method === 'POST' && kind === 'delete') {
    const want = text(body.path)
    if (!demoExists(want)) fail('文件已经不在了')
    if (DEMO_FILES.includes(want) || want in DEMO_CONTENTS) {
      const i = DEMO_FILES.indexOf(want)
      if (i >= 0) DEMO_FILES.splice(i, 1)
      delete DEMO_CONTENTS[want]
    } else if (DEMO_FILES.some((f) => f.startsWith(`${want}/`))) {
      // 目录必须空着才删，和正式版一致
      fail('目录里还有内容，不能删除')
    } else DEMO_DIRS.delete(want)
    return { ok: true }
  }
  if (kind === 'diff') {
    const want = query.get('path') ?? ''
    // 演示里没有真的仓库，不编造差异
    return { path: want, dir, diff: '', git: false, before: false, note: '在线演示里看不到真实的 git 差异' }
  }
  if (kind === 'list') return demoProjectLevel(DEMO_FILES, DEMO_DIRS, DEMO_STATUS, dir)(query.get('path') ?? '')
  if (kind === 'search') {
    const q = (query.get('q') ?? '').trim().toLowerCase()
    if (!q) return { files: [], truncated: false }
    if ((query.get('mode') ?? 'name') === 'name')
      return {
        files: DEMO_FILES.filter((f) =>
          f
            .slice(f.lastIndexOf('/') + 1)
            .toLowerCase()
            .includes(q),
        ).map((f) => ({ path: f, status: (DEMO_STATUS[f] ?? '') as never })),
        truncated: false,
      }
    const files = DEMO_FILES.filter((f) => (DEMO_CONTENTS[f] ?? '').toLowerCase().includes(q)).map((f) => ({
      path: f,
      hits: (DEMO_CONTENTS[f] ?? '')
        .split('\n')
        .map((text, i) => ({ line: i + 1, text }))
        .filter((h) => h.text.toLowerCase().includes(q))
        .slice(0, 5),
    }))
    return { files, truncated: false }
  }
  if (kind === 'content') {
    const want = query.get('path') ?? ''
    const text = DEMO_CONTENTS[want]
    const exists = want in DEMO_CONTENTS || DEMO_FILES.includes(want)
    return {
      path: want,
      exists,
      content: text ?? '',
      truncated: false,
      ...(exists ? { size: demoSize(text ?? ''), eol: (text ?? '').includes('\r\n') ? 'crlf' : 'lf' } : {}),
    }
  }
  if (kind === 'raw') fail('在线演示里没有图片')
  if (kind === 'reveal') fail('在线演示不能打开本机目录')
  return { dir, branch: p.path ? 'main' : null, isGit: !!p.path }
}

/** 演示的 Skill 列表：用户级的总是有，选了项目时多一个项目里的 */
const demoPackages = ['npm:@example/pi-web-tools', 'git:github.com/example/pi-review@v1']

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
  pythons: [
    {
      command: 'py -3.12',
      path: 'C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      version: '3.12.10',
      usable: true,
    },
  ],
  gpu: 'cuda',
  gpuName: 'NVIDIA GeForce RTX 4090',
  vram: 24,
  files: [],
}
/** 模板商店的演示：内置模板照实给，官方模板给几条示例（不联网），详情用一张 SDXL 节点图 */
const DEMO_GRAPH = localWorkflow(localModel('sdxl')!, {
  prompt: '{{prompt}}',
  negative: '{{negative}}',
  width: '{{width}}',
  height: '{{height}}',
  count: '{{count}}',
  seed: '{{seed}}',
})
const DEMO_ASSETS: Record<string, TemplateAsset[]> = {
  'z-image-turbo': [
    {
      dir: 'diffusion_models',
      file: 'z_image_turbo_bf16.safetensors',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
      gb: 11.46,
    },
    {
      dir: 'text_encoders',
      file: 'qwen_3_4b.safetensors',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
      gb: 7.49,
    },
    {
      dir: 'vae',
      file: 'ae.safetensors',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
      gb: 0.31,
    },
  ],
  image_sdxl_simple: [
    {
      dir: 'checkpoints',
      file: 'sd_xl_base_1.0.safetensors',
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      gb: 6.46,
    },
  ],
}
const DEMO_OFFICIAL: ComfyTemplateMeta[] = [
  {
    name: 'image_sdxl_simple',
    title: 'SDXL1.0: Text to Image (Simple)',
    description: 'Generate high-quality images from text prompts using the SDXL 1.0 model.',
    category: 'Image',
    tags: ['Image', 'Text to Image'],
    models: ['SDXL'],
    size: 6979321856,
    date: '2024-02-22',
    username: 'ComfyUI',
    usage: 412,
    openSource: true,
    source: 'comfy',
    output: 'image',
    available: true,
  },
  {
    name: 'z-image-turbo',
    title: 'Z-Image-Turbo: Text to Image',
    description: 'An efficient image generation model that supports English and Chinese prompts.',
    category: 'Image',
    tags: ['Image', 'Text to Image'],
    models: ['Z-Image-Turbo'],
    size: 20830591386,
    date: '2025-11-27',
    username: 'ComfyUI',
    usage: 15150,
    openSource: true,
    source: 'comfy',
    output: 'image',
    available: true,
  },
  {
    name: 'image_qwen_image_2_1_image_edit',
    title: 'Qwen Image 2.1: Image Edit',
    description: 'Edit images by feeding reference images through one checkpoint.',
    category: 'Character & Fashion',
    tags: ['Image Edit'],
    models: ['Qwen Image 2.1'],
    size: 26736171418,
    date: '2026-09-20',
    username: 'ComfyUI',
    usage: 17538,
    openSource: true,
    source: 'comfy',
    output: 'image',
    needsInput: true,
    available: true,
  },
  {
    name: 'video_wan2_2_i2v',
    title: 'Wan 2.2 14B Image to Video',
    description: 'Turn a still image into a short video clip.',
    category: 'Video',
    tags: ['Video'],
    models: ['Wan 2.2'],
    size: 28000000000,
    date: '2025-07-28',
    username: 'ComfyUI',
    usage: 9000,
    openSource: true,
    source: 'comfy',
    output: 'video',
    needsInput: true,
    available: true,
  },
]
const demoBuiltin = () => builtinTemplates(LOCAL_MODELS)
const demoBuiltinMeta = (): ComfyTemplateMeta[] =>
  demoBuiltin().map((tpl) => {
    const meta = builtinTemplateMeta([tpl])[0]
    const model = tpl.name.startsWith('builtin:') ? tpl.name.slice('builtin:'.length) : ''
    return { ...meta, ready: model ? modelReady(localModel(model)!, local) : false }
  })
const demoAssetHave = (file: string) => {
  const f = LOCAL_FILES.find((x) => x.file === file)
  return !!f && local.files.includes(f.id)
}
const demoAssetsOf = (name: string) =>
  (DEMO_ASSETS[name] ?? demoBuiltin().find((x) => x.name === `builtin:${name}`)?.assets ?? []).map((a) => ({
    ...a,
    have: demoAssetHave(a.file),
  }))
const demoCatalog = () => ({
  templates: [
    ...demoBuiltinMeta(),
    ...DEMO_OFFICIAL.map((m) => ({ ...m, ready: demoAssetsOf(m.name).every((a) => a.have) })),
  ],
  updatedAt: '',
  cached: false,
})

let demoWorkflows: ComfyWorkflow[] = []
function demoLocal(method: string, seg: string[], body: unknown): unknown {
  const [, action, id, sub] = seg
  // 演示里没有真的 ComfyUI：队列一直是空的，导入只返回一个像真的文件名
  if (action === 'queue') return { up: local.running, url: local.url, running: [], pending: [] }
  if (action === 'workflows') {
    if (method === 'POST' && sub === 'import' && id) {
      const wf = [...BUILTIN_WORKFLOWS, ...demoWorkflows].find((w) => w.id === id)
      if (!wf) return fail('找不到工作流')
      return { name: wf.name, filename: comfyImportFile(wf), url: local.url }
    }
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
    }, demoMs(400))
  }
  if (action === 'templates') {
    if (!id || id === 'refresh') return demoCatalog()
    const builtin = demoBuiltin().find((x) => x.name === id)
    const found = demoBuiltinMeta().find((x) => x.name === id) ?? DEMO_OFFICIAL.find((x) => x.name === id)
    if (!found) return fail('找不到模板')
    const meta = found
    const assets = demoAssetsOf(builtin ? builtin.name.slice('builtin:'.length) : id)
    if (sub === 'add') {
      const kind = (body as { kind?: string } | undefined)?.kind === 'web' ? 'web' : 'game'
      const wf: ComfyWorkflow = {
        id: `wf_${Date.now().toString(36)}`,
        name: `${meta.title}（副本）`,
        kind,
        use: 'any',
        description: meta.description,
        model: builtin ? builtin.name.slice('builtin:'.length) : '',
        assets: assets.map((a) => `${a.dir}/${a.file}`),
        extra: '',
        graph: builtin?.graph ?? DEMO_GRAPH,
        updatedAt: '',
      }
      demoWorkflows.push(wf)
      return wf
    }
    if (sub === 'download') {
      const files = assets.filter((a) => !a.have)
      tick(
        files.map((a) => `下载 ${a.file}`),
        () => {
          for (const a of files) {
            const f = LOCAL_FILES.find((x) => x.file === a.file)
            if (f && !local.files.includes(f.id)) local.files.push(f.id)
          }
        },
        files.reduce((n, a) => n + a.gb * 1024 ** 3, 0),
      )
      return { job: local.job, files, skipped: 0 }
    }
    return {
      template: { ...meta, ready: assets.every((a) => a.have) },
      ...(builtin ? { graph: builtin.graph } : { preview: DEMO_GRAPH }),
      assets,
    }
  }
  if (action === 'install' && method === 'POST')
    tick(
      ['检查 Python', '下载 ComfyUI', '创建 Python 虚拟环境', '安装 PyTorch', '安装 ComfyUI 的依赖', '安装完成'],
      () => {
        local.installed = true
        local.venv = {
          command: '~/agent-panel/comfyui/venv/Scripts/python.exe',
          path: '~/agent-panel/comfyui/venv/Scripts/python.exe',
          version: '3.12.10',
          usable: true,
        }
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

/** 演示的项目技能：改了只存在浏览器内存里，刷新页面回到初始内容 */
const demoProjectSkills: ProjectSkill[] = [
  {
    name: 'release-notes',
    description: '按仓库的提交说明格式整理更新说明',
    path: '/home/demo/code/web-shop/.agents/skills/release-notes/SKILL.md',
    dir: '.agents/skills/release-notes',
    source: '.agents/skills',
    clis: ['commandcode', 'gemini', 'pi'],
    issues: [],
  },
  {
    name: 'shop-i18n',
    description: '',
    path: '/home/demo/code/web-shop/.claude/skills/shop-i18n/SKILL.md',
    dir: '.claude/skills/shop-i18n',
    source: '.claude/skills',
    clis: ['claude'],
    issues: ['front matter 里缺少 description：Agent 靠它判断什么时候用这个技能'],
  },
]

/** 演示技能的内容：改 SKILL.md 时存这里 */
const demoSkillFiles = new Map<string, string>([
  [
    '.agents/skills/release-notes',
    '---\nname: release-notes\ndescription: 按仓库的提交说明格式整理更新说明\n---\n\n按最近一次发布的提交整理，一条一行。\n',
  ],
  ['.claude/skills/shop-i18n', '---\nname: shop-i18n\n---\n\n把界面文案补上英文。\n'],
])

/** 项目设置里的 Skill 分节：和 server/project-skills.ts 返回同样的字段 */
function demoProjectSkillsApi(method: string, seg: string[], query: URLSearchParams, body: Record<string, unknown>) {
  const projectPath = '/home/demo/code/web-shop'
  const repos = projectSkillRepos().map((r) => ({ ...r, exists: true }))
  const view = (): ProjectSkillsView => ({ path: projectPath, repos, skills: demoProjectSkills })
  const key = (repo: string, name: string) => `${repo}/${name}`
  const find = (repo: string, name: string) =>
    demoProjectSkills.find((s) => s.source === repo && s.name === name) ?? fail('没有这一项')
  const repo = query.get('repo') ?? ''
  const name = query.get('name') ?? ''
  if (seg[1] === 'file') {
    if (method === 'GET') {
      const skill = find(repo, name)
      return {
        content: demoSkillFiles.get(key(repo, name)) ?? '',
        files: skill.name === 'release-notes' ? ['template.md'] : [],
      }
    }
    if (method === 'DELETE') {
      find(repo, name)
      demoProjectSkills.splice(
        demoProjectSkills.findIndex((s) => s.source === repo && s.name === name),
        1,
      )
      demoSkillFiles.delete(key(repo, name))
      return { ok: true }
    }
    // PUT：改 SKILL.md，问题和说明按新内容重算
    const skill = find(repo, name)
    const content = String(body.content ?? '')
    if (!content.trim()) fail('SKILL.md 不能为空')
    demoSkillFiles.set(key(repo, name), content)
    skill.issues = skillIssues(name, content)
    skill.description = /^description:\s*(.*)$/m.exec(content)?.[1]?.trim() ?? ''
    return { ok: true, dir: `${repo}/${name}` }
  }
  if (method === 'POST') {
    const target = String(body.repo ?? '')
    const newName = String(body.name ?? '')
    if (!target || !newName) fail('名字和目录不能为空')
    if (demoProjectSkills.some((s) => s.source === target && s.name === newName)) fail(`「${newName}」已经有了`)
    const description = String(body.description ?? '')
    const content = skillTemplate(newName, description)
    demoSkillFiles.set(key(target, newName), content)
    demoProjectSkills.push({
      name: newName,
      description,
      path: `${projectPath}/${target}/${newName}/SKILL.md`,
      dir: `${target}/${newName}`,
      source: target,
      clis: projectSkillRepos().find((r) => r.dir === target)?.clis ?? [],
      issues: skillIssues(newName, content),
    })
    return { dir: `${target}/${newName}` }
  }
  return view()
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
  if (res === 'model-catalog') {
    if (method === 'POST' && id === 'lookup') fail('在线演示不能联网补全模型信息')
    const settings = Settings.parse(d.settings ?? {})
    return {
      entries: BUILTIN_MODEL_CATALOG,
      file: '~/.agent-panel/config/models.json',
      dir: '~/.agent-panel/config',
      aiLookup: settings.modelCatalog.aiLookup,
    }
  }
  if (res === 'local-image') return demoLocal(method, seg, body)
  if (res === 'project-files') return demoProjectFiles(method, seg, query, (body ?? {}) as Record<string, unknown>)
  if (res === 'project-mcp') {
    const project = d.projects.find((p) => p.id === (query.get('projectId') ?? ''))
    return demoProjectMcp(method, seg, body ?? {}, activeClis(), project?.path ?? '')
  }
  if (res === 'accounts') return demoAccounts(method, seg, body ?? {})
  if (res === 'integrations') return demoIntegrations(method, seg, body ?? {})
  if (res === 'library' || res === 'mcp-tools') return demoLibrary(method, seg, query, body ?? {}, activeClis())
  if (res === 'project-skills') return demoProjectSkillsApi(method, seg, query, (body ?? {}) as Record<string, unknown>)
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
        ...demoPanelCommands(),
        ...DEMO_SKILLS.filter((x) => query.get('projectId') || x.scope !== 'repo').map((x) => ({
          name: x.name,
          description: x.description,
          kind: 'skill' as const,
          source: x.source ?? '',
        })),
      ] satisfies SlashCommand[]
    // 演示里的扩展包：内存里记着，装、删都直接成功
    if (id && sub === 'packages') {
      if (method === 'POST') {
        const b = (body ?? {}) as { action?: string; source?: string }
        const source = String(b.source ?? '').trim()
        if (b.action === 'install' && source && !demoPackages.includes(source)) demoPackages.push(source)
        if (b.action === 'remove' && demoPackages.includes(source)) demoPackages.splice(demoPackages.indexOf(source), 1)
        const output =
          b.action === 'install' ? `Installed ${source}` : b.action === 'remove' ? `Removed ${source}` : 'Up to date'
        return { ok: true, output, packages: demoPackages.map((x) => ({ source: x, target: x })) }
      }
      return demoPackages.map((x) => ({ source: x, target: x }))
    }
    if (id && sub === 'skills')
      return DEMO_SKILLS.filter(
        (x) =>
          (query.get('projectId') || x.scope !== 'repo') &&
          !(query.get('own') === '1' && x.source === '~/.agents/skills'),
      )
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
        ...(input.kind === 'project'
          ? {
              projectPath: input.subject.path ?? '',
              defaultWorkflowIds: (() => {
                const cat = d.categories.find((c) => c.scope === 'workflow' && c.name === '项目')
                return cat ? d.workflows.filter((w) => w.categoryId === cat.id).map((w) => w.id) : []
              })(),
            }
          : {}),
        ...(input.kind === 'lessons'
          ? (() => {
              const p = d.projects.find((x) => x.id === input.projectId)
              return { projectName: p?.name, projectLessons: p?.lessons ?? [], globalLessons: d.globalLessons ?? [] }
            })()
          : {}),
      })
    }
    if (sub === 'stop') return stopDemoAssist(id) ?? fail('找不到这次生成')
    return demoAssistJob(id) ?? fail('找不到这次生成，可能已过期')
  }
  // 粘贴回来的路径：演示里只认得这次页面里上传过的附件
  if (res === 'uploads' && id === 'resolve') return { files: demoResolve((body as { paths: string[] }).paths) }
  // 演示没有本机磁盘，找不回大文件的原路径
  if (res === 'uploads' && id === 'locate') return { files: [] }
  if (res === 'uploads' && id === 'open') fail('在线演示不能打开本机的文件，下载到本机运行后可以用')
  if (res === 'uploads' && id === 'raw' && sub === 'file') {
    const p = query.get('path') ?? ''
    const text = demoUploadText(p)
    return { path: p, dir: p.replace(/\/[^/]*$/, ''), exists: text !== null, content: text ?? '', truncated: false }
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
  if (res === 'deploy') return demoDeploy(method, id, body, activeClis())
  if (res === 'ai-fix') return demoFixStart(body)
  if (res === 'doc-jobs')
    return (sub === 'stop' ? stopDemoDocJob(id) : demoDocJob(id)) ?? fail('找不到这次优化，可能已过期')
  // 演示里的项目都不是面板自己的源代码
  // 初始化前的快速扫描：演示没有本机目录，只给几条线索
  if (res === 'projects' && id === 'analyze' && method === 'POST') {
    const path = String((body as { path?: string }).path ?? '')
    return {
      name:
        path
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ?? '',
      description: '',
      workflow: 'general',
      workflowParams: { projectStructure: 'project-structure' },
      testSteps: [],
      wslDistro: '',
      category: '',
      signals: ['版本控制：git', '技术栈：前端 + TypeScript'],
    }
  }
  if (res === 'projects' && id && sub === 'panel-source') return { panelSource: false }
  if (res === 'projects' && id && sub === 'files') {
    const q = (query.get('q') ?? '').toLowerCase()
    return DEMO_FILES.filter((f) => f.toLowerCase().includes(q)).slice(0, 30)
  }
  if (res === 'fs' && id === 'inspect') return inspectDir(query.get('path') ?? '')
  if (res === 'fs' && id === 'branches') {
    const path = normalize(query.get('path') ?? '')
    const node = TREE[path]
    if (!node?.git) throw new Error('这个目录不是 git 仓库')
    return { current: node.git, branches: node.branches ?? [node.git] }
  }
  if (res === 'fs' && id === 'checkout') {
    const b = body as { path: string; branch: string }
    const path = normalize(b.path)
    const node = TREE[path]
    if (!node?.git) throw new Error('切换分支失败：这个目录不是 git 仓库')
    if (!(node.branches ?? []).includes(b.branch)) throw new Error(`切换分支失败：没有这个分支：${b.branch}`)
    node.git = b.branch
    return inspectDir(path)
  }
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
      if (isCoreAgent(d.agents.find((a) => a.id === id))) fail('必备角色不能删除')
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
    // 必备角色只能改参数取值和运行配置；复制出来的是普通角色
    const coreBefore = method === 'POST' ? undefined : d.agents.find((a) => a.id === id && isCoreAgent(a))
    if (method === 'POST' && isCoreAgent(input)) input.origin = ''
    if (coreBefore) {
      const def = coreDefinition(coreKey(coreBefore)!)
      const next = syncCore(input, def, { categoryId: coreBefore.categoryId, includes: coreBefore.includes })
      return update('agents', id, { ...next, name: coreBefore.name, origin: coreBefore.origin }, 'Agent 不存在')
    }
    // 和服务端一样：去掉引入自己的，会形成循环就拒绝
    const self = method === 'POST' ? '' : id
    input.includes = [...new Set(input.includes)].filter((x) => x !== self)
    const before = d.agents.find((a) => a.id === self)
    if (self && !(before && includeCycle(before, d.agents).length)) {
      const all = d.agents.map((a) => (a.id === self ? { ...a, ...input } : a))
      const cycle = includeCycle({ id: self, includes: input.includes }, all)
      if (cycle.length) fail(`引入关系会形成循环：${cycleText(cycle, all)}`)
    }
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
      const err = projectCategoryDeleteError(id)
      if (err) fail(err)
      remove('projectCategories', id, '分类不存在')
      d.projects = d.projects.map((p) => (p.categoryId === id ? { ...p, categoryId: '' } : p))
      persist()
      return undefined
    }
    const input = parse(ProjectCategoryInput, body)
    if (d.projectCategories.some((c) => c.name === input.name && c.id !== id)) fail(`分类「${input.name}」已存在`)
    if (input.workflowId && !d.workflows.some((w) => w.id === input.workflowId)) fail('工作流不存在')
    // 新建的自建分类明确带 builtin: false，和正式后端的响应字段一致（update 会保留原有的标记）
    return method === 'POST'
      ? { ...create('projectCategories', input), builtin: false }
      : update('projectCategories', id, input, '分类不存在')
  }

  // 演示按 Windows 上装了 Git Bash 和 WSL 的情况显示命令行环境（默认 Git Bash 在前）
  if (res === 'shells')
    return {
      platform: 'win32',
      shells: [
        { id: 'gitbash', path: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        { id: 'wsl', path: 'wsl.exe', distros: ['Ubuntu-24.04', 'Debian'] },
        { id: 'powershell', path: 'powershell.exe' },
        { id: 'cmd', path: 'cmd.exe' },
      ],
    }
  if (res === 'global-lessons') {
    if (method === 'GET') return d.globalLessons ?? []
    const b = (body ?? {}) as { lessons?: unknown; confirmed?: unknown }
    if (b.confirmed !== true) fail('修改全局教训需要你确认')
    d.globalLessons = parse(GlobalLessons, b.lessons)
    persist()
    return d.globalLessons
  }
  if (res === 'projects' && id && sub === 'lessons' && method === 'POST') {
    const p = d.projects.find((x) => x.id === id) ?? fail('项目不存在')
    const b = (body ?? {}) as Partial<ProjectLesson>
    const l = parse(ProjectLesson, {
      ...b,
      id: b.id || newLessonId(),
      source: 'user',
      createdAt: b.createdAt || new Date().toISOString(),
    })
    const r = upsertLesson(p.lessons, l)
    if (r.full) fail('项目教训已经有 200 条，先在项目设置里合并同类项再记')
    Object.assign(p, { lessons: r.list, updatedAt: new Date().toISOString() })
    persist()
    return p
  }
  if (res === 'projects') {
    // 和真正的服务端一样：按添加时间或拖拽后的顺序排，返回给前端的顺序就是侧栏顺序
    if (method === 'GET') return sortProjects(d.projects)
    if (method === 'PUT' && id === 'order') {
      if (!Array.isArray(body) || !body.every((x) => typeof x === 'string' && x.trim())) fail('项目顺序格式不对')
      const ids = body as string[]
      const error = projectOrderError(d.projects, ids)
      if (error) fail(error)
      d.projects = orderProjects(d.projects, ids)
      persist()
      return sortProjects(d.projects)
    }
    if (method === 'DELETE') {
      remove('projects', id, '项目不存在')
      d.tasks = (d.tasks ?? []).filter((t) => t.projectId !== id)
      persist()
      return undefined
    }
    const input = parse(ProjectInput, body)
    if (input.categoryId && !d.projectCategories.some((c) => c.id === input.categoryId)) fail('项目分类不存在')
    if (input.workflowId && !d.workflows.some((w) => w.id === input.workflowId)) fail('工作流不存在')
    // 和服务端一样：没指定默认工作流、分类也没有时不能保存
    if (!input.workflowId && !d.projectCategories.find((c) => c.id === input.categoryId)?.workflowId)
      fail('请为项目选择子对话默认工作流')
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
    const path = `/demo/uploads/${crypto.randomUUID()}/${name}`
    // 和真实服务端一样把转录内容存下来：粘贴回剪贴板里的路径时能认回附件、点开能看到内容
    demoUploads.set(
      path,
      `data:text/markdown;charset=utf-8,${encodeURIComponent(`# 参考会话：${title}\n\n这是演示里的对话记录。`)}`,
    )
    return { name, path, size: 4096, mime: 'text/markdown' }
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
  if (res === 'usage') return demoUsage(d, query)

  return fail(`未知接口：${method} ${path}${sub ? '/' + sub : ''}`)
}

/** 演示里的用量统计：按浏览器里存的演示任务算，和正式版用同一个聚合函数 */
function demoUsage(d: Db, query: URLSearchParams) {
  const grain = UsageQuery.grain(query.get('grain'))
  return usageReport(d.tasks ?? [], { grain, count: UsageQuery.count(query.get('count'), grain) })
}

export async function handle(method: string, url: string, body: unknown) {
  // 稍微延迟一下，模拟真实请求，让「保存中」等状态能被看到
  await new Promise((r) => setTimeout(r, demoMs(120)))
  // 界面检查用：让发消息的请求慢一点回来，模拟「上一条还在发送」时又按了一次回车。
  // 只有演示版里有这段代码，正式包里没有演示后端
  let slow = 0
  try {
    slow = Number(globalThis.localStorage?.getItem('demo-slow-messages') ?? 0)
  } catch {}
  if (slow > 0 && method === 'POST' && /\/tasks\/[^/]+\/messages$/.test(url))
    await new Promise((r) => setTimeout(r, demoMs(slow)))
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
/** held：执行中收下、这一轮结束后接着处理的消息（消息已经记进对话） */
const live = new Map<
  string,
  { stop: boolean; done?: Promise<unknown>; held?: { text: string; attachments: Attachment[] }[] }
>()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, demoMs(ms)))

function projectWorkflow(d: Db, p: Project) {
  const id = p.workflowId || d.projectCategories.find((c) => c.id === p.categoryId)?.workflowId
  if (id) return d.workflows.find((w) => w.id === id)
  // 和正式版一样：没指定时落到「通用项目」，再不行才用「默认」
  return (
    d.workflows.find((w) => w.origin === 'builtin:project-general') ??
    d.workflows.find((w) => w.name === '通用项目') ??
    d.workflows.find((w) => w.id === DEFAULT_WORKFLOW_ID)
  )
}

function startTurn(d: Db, task: Task, prompt: string, first: boolean, fast = false, resume = false) {
  const entry: { stop: boolean; done?: Promise<unknown>; held?: { text: string; attachments: Attachment[] }[] } = {
    stop: false,
  }
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
    resume,
    sleep: fast ? async () => {} : sleep,
    stopped: () => entry.stop,
    changed: (flush) => {
      task.updatedAt = new Date().toISOString()
      trackWait(task)
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
    // 和正式版一样：这一轮完成后马上接着处理执行中收到的消息
    const next = task.status === 'done' ? entry.held?.shift() : undefined
    if (next) void followUp(d, task, next.text, fast, next.attachments, true)
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
  } else if (input.agentId && !d.agents.some((a) => a.id === input.agentId)) fail('请选择对话的 Agent')
  const lack = chatMissingParams(input, d.agents)
  if (lack) fail(lack)
  const task = create<Task>('tasks', {
    ...newTask(
      input,
      workflow,
      new Date().toISOString(),
      `demo-${crypto.randomUUID()}`,
      workflow
        ? taskSnapshot(
            workflow,
            d.workflows,
            {},
            {
              agents: d.agents,
              testSteps: project?.testSteps ?? [],
              platform: 'win32',
              wslDistro: project?.wslDistro ?? '',
            },
          )
        : [],
    ),
    simulated: true,
    // 演示里按 Windows 展示测试步骤的环境说明（WSL 步骤怎么跑）
    testSteps: workflow ? (project?.testSteps ?? []) : [],
    platform: workflow ? 'win32' : '',
  })
  // 演示里没有真的仓库：只记下分支信息，让界面能展示合并 / 丢弃。
  // 和服务端一致：只有顶层对话能选独立分支，子对话和父对话共用目录
  const isolate = !!input.isolate && !input.parentTaskId
  if (isolate && project)
    task.worktree = {
      path: '',
      branch: `agent-panel/${task.id.slice(5, 13)}`,
      baseBranch: 'main',
      state: 'active',
      note: '',
    }
  return { task, done: startTurn(d, task, withAttachments(input.prompt, input.attachments), true, fast) }
}

/** recorded：消息已经在对话里（执行中收到时就记下了），不再加一条 */
function followUp(d: Db, task: Task, text: string, fast = false, attachments: Attachment[] = [], recorded = false) {
  if (live.has(task.id)) fail('任务正在执行，请等它完成或先停止')
  dropEndNotes(task)
  if (!recorded)
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

/** 演示里点过「合并」的独立分支（没有真的仓库，只记在内存里） */
const demoMerged = new Set<string>()

// ---- 进程与内存（演示） ----
/** 字符串散成稳定的数字：同一个对话每次打开看到同样的 pid，截图和验证都对得上 */
function hashNum(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** 演示里「关掉了」的进程：只留在内存里，刷新页面重新出现 */
const demoGone = new Map<string, Set<number>>()

const MB = 1024 * 1024

function demoProcesses(task: Task, tasks: Task[]): TaskProcesses {
  const now = Date.now()
  const rootId = task.rootTaskId || task.id
  const gone = demoGone.get(rootId) ?? new Set<number>()
  const base = (hashNum(rootId) % 20000) + 30000
  const started = (x: Task) => {
    const at = Date.parse(x.runStartedAt || x.updatedAt || '')
    return Number.isFinite(at) ? at : now - 12 * 60_000
  }
  const rows: TaskProcess[] = []
  const push = (pid: number, o: Omit<TaskProcess, 'pid'>) => {
    if (!gone.has(pid)) rows.push({ pid, ...o })
  }
  const active = demoLive(task) ? 'running' : 'idle'
  const cliTitle = task.title
  push(base, {
    parentPid: null,
    command: `pi --print --mcp-config {"mcpServers":{"panel":{}}} 对话：${task.title}`,
    ownerTaskId: task.id,
    ownerTitle: cliTitle,
    startedAt: started(task),
    durationMs: now - started(task),
    rss: 168 * MB,
    status: active,
    kind: 'cli',
  })
  // CLI 自己起的子进程（MCP 桥接、shell）：正式后端也把它们算进这个对话
  push(base + 1, {
    parentPid: base,
    command: 'node /home/u/.agent-panel/cache/cli-run/demo/ask-mcp.mjs',
    ownerTaskId: task.id,
    ownerTitle: cliTitle,
    startedAt: started(task) + 1200,
    durationMs: now - started(task) - 1200,
    rss: 46 * MB,
    status: active,
    kind: 'child',
  })
  // 在干的子对话
  for (const kid of tasks.filter((x) => x.parentTaskId === task.id && demoLive(x)).slice(0, 3)) {
    const at = started(kid)
    push(base + 10 + tasks.indexOf(kid), {
      parentPid: null,
      command: `codex app-server 子对话：${kid.title}`,
      ownerTaskId: kid.id,
      ownerTitle: kid.title,
      startedAt: at,
      durationMs: now - at,
      rss: 92 * MB,
      status: 'running',
      kind: 'cli',
    })
  }
  // 任务已经结束、进程还留着的残留：演示「清理无效进程」用
  const orphanAt = now - 46 * 60_000
  push(base + 99, {
    parentPid: null,
    command: 'claude --mcp-config {"mcpServers":{"panel":{}}} 已结束的子任务',
    ownerTaskId: `${task.id}-demo-old`,
    ownerTitle: '已结束的子任务',
    startedAt: orphanAt,
    durationMs: now - orphanAt,
    rss: 24 * MB,
    status: 'orphan',
    kind: 'cli',
  })
  const cliMemory = rows.reduce((sum, p) => sum + (p.rss ?? 0), 0)
  const serverMemory = (268 + Math.round(Math.sin(now / 240_000) * 6)) * MB
  return {
    sampledAt: now,
    processes: rows,
    cliMemory,
    serverMemory,
    totalMemory: cliMemory + serverMemory,
    unavailable: '',
  }
}

/** 演示任务算不算「还在跑」 */
function demoLive(task: Task) {
  return task.working === true || live.has(task.id)
}

function demoKill(task: Task, pid: number) {
  const rootId = task.rootTaskId || task.id
  const set = demoGone.get(rootId) ?? new Set<number>()
  set.add(pid)
  demoGone.set(rootId, set)
  return { ok: true, pid, error: '' }
}

function demoClean(task: Task, body: unknown) {
  const panel = demoProcesses(task, load().tasks ?? [])
  const want = (body as { pids?: unknown } | undefined)?.pids
  const asked = Array.isArray(want) ? want.filter((x): x is number => Number.isInteger(x)) : []
  const orphans = panel.processes.filter((p) => p.status === 'orphan' && p.kind === 'cli')
  const targets = asked.length ? orphans.filter((p) => asked.includes(p.pid)) : orphans
  const rootId = task.rootTaskId || task.id
  const set = demoGone.get(rootId) ?? new Set<number>()
  for (const p of targets) set.add(p.pid)
  demoGone.set(rootId, set)
  return { killed: targets.map((p) => p.pid), skipped: [], gone: [] }
}

function demoSuggest(task: Task, tasks: Task[]) {
  const orphans = demoProcesses(task, tasks).processes.filter((p) => p.status === 'orphan')
  return {
    suggestions: orphans.map((p) => ({ pid: p.pid, reason: `所属任务已经结束，进程还留着（${p.ownerTitle}）` })),
    text: '',
    error: '',
  }
}

function demoMemory(task: Task, query: URLSearchParams): TaskMemoryHistory {
  const intervalMs = 30_000
  const capacity = 2000
  const now = Date.now()
  const base = hashNum(task.rootTaskId || task.id)
  const from = Number(query.get('from') ?? '')
  const to = Number(query.get('to') ?? '')
  const points: TaskMemoryHistory['points'] = []
  // 两小时、30 秒一点，够看清趋势也能验证左右拖动
  for (let i = 239; i >= 0; i--) {
    const t = Math.floor(now / intervalMs) * intervalMs - i * intervalMs
    if (Number.isFinite(from) && from > 0 && t < from) continue
    if (Number.isFinite(to) && to > 0 && t > to) continue
    const wave = Math.sin(t / 900_000 + (base % 7)) * 28 + Math.sin(t / 240_000) * 8
    const cli = Math.round((132 + wave) * MB)
    const server = Math.round((268 + Math.sin(t / 300_000 + 1) * 6) * MB)
    points.push({ t, server, cli, total: cli + server })
  }
  return { sampledAt: now, intervalMs, capacity, points }
}

/** 演示版的内存分析：和正式后端同一套口径（shared/memory-analysis.ts），数字来自演示数据 */
function demoMemoryAnalysis(task: Task, tasks: Task[], projects: Project[]): TaskMemoryAnalysis {
  const history = demoMemory(task, new URLSearchParams())
  const points = history.points
  const panel = demoProcesses(task, tasks)
  const owners = ownersOf(panel.processes, task.id)
  const tree = runTree(task, tasks)
  const contexts = tree
    .map((x) => {
      let best = { context: 0, window: 0 }
      for (const u of Object.values(x.usage?.agents ?? {})) {
        if ((u.context ?? 0) > best.context) best = { context: u.context ?? 0, window: u.window ?? 0 }
      }
      return { id: x.id, title: x.title, ...best, self: x.id === task.id }
    })
    .filter((x) => x.context > 0)
  const project = projects.find((p) => p.id === task.projectId) ?? null
  const trend = taskMemoryTrend(points)
  const report = taskMemoryReport({
    task: { title: task.title, mode: task.mode, status: task.status },
    project: project ? { name: project.name, path: project.path } : null,
    points,
    intervalMs: history.intervalMs,
    panel: { cliMemory: panel.cliMemory, serverMemory: panel.serverMemory, unavailable: panel.unavailable },
    owners,
    tree: {
      tasks: tree.length,
      children: tree.length - 1,
      running: tree.filter((x) => x.status === 'running').length,
    },
    contexts,
  })
  return {
    sampledAt: Date.now(),
    intervalMs: history.intervalMs,
    report: clipReport(report),
    ask: TASK_MEMORY_ASK,
    cwd: project?.path ?? '',
    trend: trend?.trend ?? null,
    trendText: taskTrendText(trend),
    owners: owners.map(({ taskId, title, self, rss, count, counted }) => ({
      taskId,
      title,
      self,
      rss,
      count,
      counted,
    })),
    tree: {
      tasks: tree.length,
      children: tree.length - 1,
      running: tree.filter((x) => x.status === 'running').length,
    },
  }
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
      // 和正式版一样：子对话不进项目列表，在父对话里看
      return (pid ? tasks.filter((t) => t.projectId === pid) : tasks).filter((t) => !t.parentTaskId).map(taskSummary)
    }
    return createTask(d, parse(NewTaskInput, body)).task
  }
  // 导入别人导出的任务：和正式版一样连同包里的子对话一起建成只读的，返回父任务在前的整棵树
  if (id === 'import' && method === 'POST') {
    const b = (body ?? {}) as { projectId?: string; bundle?: unknown }
    if (b.projectId && !d.projects.some((p) => p.id === b.projectId)) fail('项目不存在')
    const bundle = parseTaskExport(b.bundle)
    const made = importTaskTree(bundle, b.projectId ?? '', [
      `demo-${crypto.randomUUID()}`,
      ...bundle.children.map(() => `demo-${crypto.randomUUID()}`),
    ])
    tasks.unshift(...made)
    persist()
    return made
  }
  const task = tasks.find((t) => t.id === id) ?? fail('任务不存在')
  if (
    task.imported &&
    (['messages', 'resume', 'compact', 'review', 'rewind', 'fork', 'requests', 'revert', 'end-flow'].includes(
      sub ?? '',
    ) ||
      (method === 'PATCH' && Object.keys((body ?? {}) as object).some((k) => k !== 'title' && k !== 'archived')))
  )
    fail('这是导入的任务，只能查看，不能继续执行')
  if (method === 'DELETE') {
    if (live.has(id)) live.get(id)!.stop = true
    remove('tasks', id, '任务不存在')
    return undefined
  }
  if (sub === 'stop') {
    if (live.has(id)) live.get(id)!.stop = true
    // 和真实后端一样：还在等回答的提问马上作废，返回的任务里不能再带着它，不然提问窗口关不掉
    if (task.requests?.some((r) => r.kind !== 'confirm')) {
      task.requests = task.requests.filter((r) => r.kind === 'confirm')
      persist()
    }
    // 强制停止：演示里没有常驻 CLI，把这一轮的进程状态直接丢掉就相当于结束了进程
    if (query.get('force')) live.delete(id)
    return task
  }
  // 演示里没有常驻 CLI，页面在场状态和预热都不用处理
  if (sub === 'presence' || sub === 'prewarm') return task
  // 打开看过这一轮：清掉侧栏的橙点
  if (sub === 'seen') {
    task.turnSeenAt = task.turnDoneAt
    persist()
    return task
  }
  if (sub === 'end-flow') {
    if (live.has(task.id)) fail('任务正在执行，请先停止')
    if (task.mode !== 'workflow') fail('只有工作流任务可以结束流程')
    closeFlow(task, `demo-${crypto.randomUUID()}`)
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
      // 和真实执行一样：压缩是回复里的一次工具调用，写明压缩了多少、现在占多少
      const last = [...task.messages].reverse().find((m) => m.role === 'agent')
      const usage = last ? task.usage.agents[last.agentId] : undefined
      const window = usage?.window || 200_000
      const before = usage?.context || 86_400
      const after = Math.round(before * 0.18)
      if (usage) usage.context = after
      const k = (n: number) => `${(n / 1000).toFixed(1)}k`
      task.messages.push({
        id: `demo-${crypto.randomUUID()}`,
        role: 'agent',
        agentId: last?.agentId ?? '',
        step: '',
        text: '',
        tools: [
          {
            kind: 'compact',
            name: '压缩上下文',
            label: `压缩了 ${k(before - after)} token（${k(before)} → ${k(after)}）`,
            detail: `当前占用 ${Math.round((after / window) * 100)}%`,
            output: `压缩前：${k(before)} token\n压缩后：${k(after)} token\n上下文窗口：${k(window)} token\n当前占用：${Math.round((after / window) * 100)}%`,
          },
        ],
        at,
      })
      persist()
      return task
    }
    const base = (body as { base?: string } | undefined)?.base
    void followUp(d, task, base ? `审查相对 ${base} 的改动` : '审查还没提交的改动')
    return task
  }
  // 进程面板：演示版给一份稳定的假进程和内存历史，字段和正式后端一致
  if (sub === 'processes') {
    if (method === 'GET' && !rid) return demoProcesses(task, tasks)
    if (method === 'POST' && rid === 'clean') return demoClean(task, body)
    if (method === 'POST' && rid === 'suggest') return demoSuggest(task, tasks)
    if (method === 'POST' && rid) return demoKill(task, Number(rid))
  }
  if (sub === 'memory' && method === 'GET') return demoMemory(task, query)
  if (sub === 'memory-analysis' && method === 'GET') return demoMemoryAnalysis(task, tasks, d.projects ?? [])
  if (sub === 'run-usage' && method === 'GET') return runUsage(task, tasks)
  // 子对话的统计合计：和正式后端一样，把子对话（含多层）的耗时、token、报错汇总进来
  if (sub === 'children-stats' && method === 'GET')
    return descendantTotals(runTree(task, tasks).filter((x) => x.id !== task.id))
  // 导出任务连同子对话：和正式后端一样把整棵树整理成一个包，超体积时不生成
  if (sub === 'export' && method === 'GET') {
    const bundle = exportTaskTree(task, tasks, d.agents ?? [], query.get('app') ?? '')
    return { bundle, bytes: checkExportSize(bundle) }
  }
  if (sub === 'children' && method === 'GET')
    return tasks
      .filter((x) => x.parentTaskId === task.id)
      .map((x) => {
        const doing = childActivity(x)
        const open = openPlan(x)
        // 还在跑 / 排队的后台命令：和正式版一样，CLI 在等命令结果时也算还没做完
        const background = (x.jobs ?? []).filter((j) => j.state === 'running' || j.state === 'queued').length
        return {
          id: x.id,
          title: x.title,
          status: x.status,
          summary: x.summary,
          working: x.working,
          updatedAt: x.updatedAt,
          // 进程还活着：正在跑的一定活着（演示里没有真的进程，就按 working 认）
          cliAlive: live.has(x.id) || x.working,
          startedAt: childStartedAt(x),
          // 和正式版一致：等用户确认的请求数、没回答的提问数，行右边的时长靠它判断停在等你
          requests: (x.requests ?? []).length,
          asking: x.parentAsks?.length ?? 0,
          // 计划没做完：和正式版一致，显示「计划 7/8」、不算已完成；带上正在做的那一步
          plan: open ? { ...open, step: doing?.plan?.title, child: doing?.plan?.child } : undefined,
          // 和正式版一致：父对话的子对话栏靠这两项显示在做什么、多久没新输出
          activity: doing,
          lastActivityAt: childLastActivity(x),
          // 和正式后端对齐：运行区、悬浮层都靠这几项判断「还在跑 / 在等什么」
          background,
          workflow: runRunning(x),
          helpers: helpersWorking(x),
          unmerged: x.worktree?.state === 'active',
          // 和正式后端对齐：独立分支目录里还有几个文件没提交（没真的 git，按工作区状态给一个固定的数）
          dirty: x.worktree?.state === 'active' ? 1 : 0,
          dir: x.worktree?.path ?? '',
          wrapup: !!x.wrapRequest && x.wrapRequest.state !== 'failed',
          branch: x.worktree?.branch ?? '',
          stopReason: x.stopReason ?? '',
          waiting: childWait(x, { background, cliAlive: live.has(x.id) }),
          resolved: x.resolved === true,
        }
      })
  // 演示里没有真的在跑的子对话进程，停止全部子对话什么也不用做
  if (sub === 'children' && method === 'POST' && rid === 'stop') return { stopped: 0 }
  // 终止一个子任务：和正式版一样走 stopHelper，排队的马上按「已终止」交回，在跑的这一步跑完后按终止交回
  if (sub === 'subtasks' && method === 'POST' && rid === 'stop') {
    const step = typeof (body as { step?: unknown })?.step === 'string' ? (body as { step: string }).step : ''
    if (!task.steps.some((s) => s.id === step && s.slot === 'sub')) fail('找不到这个子任务', 404)
    if (!stopHelper(task.id, step, '用户在界面上终止了这个子任务')) fail('这个子任务已经结束了', 409)
    return task
  }
  if (sub === 'messages') {
    const f = parse(FollowUpInput, body)
    const cur = live.get(task.id)
    // 演示里没有常驻 CLI：执行中收到的消息直接记进对话，这一轮结束后接着处理
    if (cur && !f.interrupt) {
      const msg = {
        id: `demo-${crypto.randomUUID()}`,
        role: 'user' as const,
        agentId: '',
        step: task.mode === 'workflow' ? (task.steps.find((s) => s.status === 'running' && !s.parentId)?.id ?? '') : '',
        text: f.text,
        tools: [],
        ...(f.attachments.length ? { attachments: f.attachments } : {}),
        // 和正式后端对齐：执行中发的消息记下交付结果（演示里这一轮收不下，结束后接着处理）
        delivery: { how: 'held' as const, at: new Date().toISOString() },
        at: new Date().toISOString(),
      }
      task.messages.push(msg)
      ;(cur.held ??= []).push({ text: f.text, attachments: f.attachments })
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
  // 回答子对话的提问：演示里只把卡片标成已回答 / 已交给父对话决定
  if (sub === 'child-asks' && rid) {
    const m = task.messages.find((x) => x.id === rid && x.ask) ?? fail('找不到这个提问')
    const a = body as { answer: string; delegate: boolean }
    if (!a.delegate) m.ask = { ...m.ask!, answer: a.answer, by: 'user' }
    else m.ask = { ...m.ask!, delegated: true, delegatedAt: new Date().toISOString() }
    persist()
    return { task, nudge: a.delegate ? { ok: true, how: 'next' } : undefined }
  }
  // 子对话请用户决定的提问点了关闭：都不回答，父对话的卡片记成不回答，子对话终止
  if (sub === 'parent-asks' && rid === 'close') {
    const parent = tasks.find((x) => x.id === task.parentTaskId)
    for (const a of task.parentAsks ?? []) {
      const m = parent?.messages.find((x) => x.id === a.id && x.ask)
      if (m) m.ask = { ...m.ask!, answer: '不回答，终止了子对话', by: 'user', declined: true }
    }
    task.parentAsks = []
    if (live.has(id)) live.get(id)!.stop = true
    task.working = false
    task.status = 'stopped'
    task.stopReason = 'user'
    persist()
    return task
  }
  // 回答 Agent 的请求：去掉请求，记一条说明；模拟执行那边在等它消失
  if (sub === 'requests' && rid) {
    const req = (task.requests ??= []).find((r) => r.id === rid) ?? fail('这个请求已经结束了')
    const a = body as { allow: boolean; answer?: string; answers?: string[] }
    simAnswers.set(rid, a)
    task.requests = task.requests.filter((r) => r.id !== rid)
    trackWait(task)
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
  // 独立分支：演示里没有真的仓库，合并只记一下「已经合进去了」，删除改状态
  if (sub === 'worktrees') {
    const list = [task, ...tasks.filter((x) => x.parentTaskId === task.id)].filter((x) => x.worktree)
    return {
      items: list.map((x) => {
        const wt = x.worktree!
        const merged = wt.state === 'merged' || (wt.state === 'active' && demoMerged.has(x.id))
        return {
          taskId: x.id,
          title: x.title,
          child: x.id !== task.id,
          working: !!x.working,
          branch: wt.branch,
          baseBranch: wt.baseBranch,
          path: wt.path,
          state: wt.state,
          note: wt.note,
          home: wt.state === 'active' ? 'E:\\Project\\demo' : '',
          exists: wt.state === 'active',
          ahead: merged || wt.state !== 'active' ? 0 : 2,
          dirty: merged || wt.state !== 'active' ? 0 : 1,
          merged,
        }
      }),
    }
  }
  if (sub === 'worktree' && task.worktree) {
    if (task.working) fail('对话正在执行，等这一轮结束后再处理独立分支')
    if (rid === 'merge') {
      demoMerged.add(task.id)
      // 字段和正式后端对齐：没有真的 git，两边提交记录和重叠文件都是空
      return { task, into: task.worktree.baseBranch || 'main', overlap: [], sides: null }
    }
    const merged = demoMerged.has(task.id)
    task.worktree = {
      ...task.worktree,
      state: merged ? 'merged' : 'discarded',
      note: merged ? task.worktree.baseBranch : '',
    }
    persist()
    return task
  }
  // 演示里没有真的项目目录：示例工程里的文件按演示内容返回，别的文件说明看不到
  if (sub === 'file') {
    const want = (query.get('path') ?? '').replace(/^\.\//, '')
    const content = DEMO_CONTENTS[want]
    return { path: want, dir: '', exists: content !== undefined, content: content ?? '', truncated: false }
  }
  // 任务右栏的文件：根信息、按层读取、搜索，和正式版一致；改过的文件带上状态
  if (sub === 'files') {
    const p = d.projects.find((x) => x.id === task.projectId)
    const changed = new Set((task.changes ?? []).map((c) => c.path))
    const dir = p?.path || '~/demo/shop'
    const status = { ...DEMO_STATUS }
    for (const f of changed) status[f] = 'M'
    if (rid === 'list') return demoProjectLevel(DEMO_FILES, DEMO_DIRS, status, dir)(query.get('path') ?? '')
    if (rid === 'search') {
      const q = (query.get('q') ?? '').trim().toLowerCase()
      if (!q) return { files: [], truncated: false }
      if ((query.get('mode') ?? 'content') === 'name')
        return {
          files: DEMO_FILES.filter((f) =>
            f
              .slice(f.lastIndexOf('/') + 1)
              .toLowerCase()
              .includes(q),
          ).map((f) => ({ path: f, status: (status[f] ?? '') as never })),
          truncated: false,
        }
      return {
        files: DEMO_FILES.filter((f) => (DEMO_CONTENTS[f] ?? '').toLowerCase().includes(q)).map((f) => ({
          path: f,
          hits: (DEMO_CONTENTS[f] ?? '')
            .split('\n')
            .map((text, i) => ({ line: i + 1, text }))
            .filter((h) => h.text.toLowerCase().includes(q))
            .slice(0, 5),
        })),
        truncated: false,
      }
    }
    return { dir, branch: p?.path ? 'main' : null, isGit: !!p?.path }
  }
  // 演示里没有本机的文件管理器：和「打开数据目录」一样明说打不开，不假装成功
  if (sub === 'reveal') fail('在线演示不能打开本机目录')
  // 演示里没有真的目录：差异用 Agent 修改文件时给出的改动拼出来，不能撤销
  if (sub === 'diff') {
    const file = query.get('path') ?? ''
    const diff =
      task.messages
        .flatMap((m) => m.tools)
        .filter((x) => x.kind === 'edit' && x.label === file && x.input)
        .map((x) => x.input)
        .join('\n') ||
      DEMO_DIFFS[file] ||
      ''
    return { path: file, dir: '', diff, git: false, before: false }
  }
  if (sub === 'resume') {
    if (live.has(task.id)) fail('任务正在执行', 409)
    const blocked = !!blockedStep(task, taskFlow(task, taskWorkflows(task, d.workflows).workflow))
    if (task.status !== 'failed' && task.status !== 'stopped' && !blocked) fail('只有失败或停止的任务可以继续', 409)
    if ((body as { latest?: boolean } | undefined)?.latest && task.workflowId) {
      const fresh =
        d.workflows.find((w) => w.id === task.workflowId) ?? fail('工作流已经被删除，只能按任务创建时的工作流继续')
      const project = d.projects.find((p) => p.id === task.projectId)
      const agents = d.agents
      task.workflows = taskSnapshot(
        fresh,
        d.workflows,
        {},
        {
          agents,
          testSteps: project?.testSteps ?? [],
          platform: 'win32',
          wslDistro: project?.wslDistro ?? '',
        },
      )
      task.workflowName = fresh.name
      if (project) {
        task.testSteps = project.testSteps
        task.platform = 'win32'
      }
    }
    dropEndNotes(task)
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    void startTurn(d, task, users.at(-1)?.text ?? '', false, false, true)
    return task
  }
  if (method === 'PATCH') {
    const { childRun, ...rest } = parse(TaskPatch, body)
    Object.assign(task, rest)
    if (childRun !== undefined) task.childRun = childRun ?? undefined
    persist()
    return task
  }
  return task
}

/** 示例任务的节点也是瞬间跑完的：把执行时长按顺序分给主流程节点，子节点在父节点的时间里依次排开 */
function spreadSteps(t: Task) {
  const iso = (ms: number) => new Date(ms).toISOString()
  const place = (list: TaskStep[], from: number, to: number) => {
    // 长短错开一点，看起来像真实执行
    const w = list.map((_, i) => 3 + ((i * 7) % 5))
    const sum = w.reduce((a, b) => a + b, 0)
    let at = from
    list.forEach((s, i) => {
      const end = at + ((to - from) * w[i]) / sum
      s.startedAt = iso(at)
      s.endedAt = iso(end)
      const kids = t.steps.filter((k) => k.parentId === s.id && k.startedAt)
      // 子节点留出头尾一点时间给节点自己
      if (kids.length) place(kids, at + (end - at) * 0.1, end - (end - at) * 0.05)
      at = end
    })
  }
  const end = Date.parse(t.updatedAt)
  place(
    t.steps.filter((s) => !s.parentId && s.startedAt && s.kind !== 'main'),
    end - t.runMs,
    end,
  )
  // 主 Agent 调度整个流程：从头到尾
  for (const m of t.steps.filter((s) => s.kind === 'main' && !s.parentId && s.startedAt)) {
    m.startedAt = iso(end - t.runMs)
    m.endedAt = iso(end)
  }
}

/** 示例对话派出的子任务：输入框上方的「子任务」栏、列表和只读窗口都要有东西看 */
function demoHelper(task: Task, agent: { id: string; name: string }) {
  const end = task.messages.at(-1)?.at ?? new Date().toISOString()
  const start = new Date(Date.parse(end) - 8_600).toISOString()
  // 这个对话在模拟执行时已经派过子角色（@chat/sub/h1、h2），取一个没被占用的编号：
  // 用同一个 id 会跟已有的子任务撞在一起，列表里只显示前一个同 id 的标题
  const used = new Set(task.steps.map((s) => s.id))
  const id = (() => {
    let i = 1
    while (used.has(`@chat/sub/h${i}`)) i++
    return `@chat/sub/h${i}`
  })()
  const title = '核对角标的订阅时机'
  const result = '角标在首次渲染时读了一次购物车快照，加购后没有订阅 `cart:changed`。问题在 `CartBadge.tsx`。'
  task.steps.push({
    id,
    parentId: '@chat',
    slot: 'sub',
    round: 0,
    workflowId: '',
    flowId: '',
    nodeId: '',
    kind: 'agent',
    title,
    agentId: agent.id,
    status: 'done',
    startedAt: start,
    endedAt: end,
    spentMs: 0,
    waitMs: 0,
    waitStartedAt: '',
    output: result,
    verdict: '',
    rounds: 0,
    reruns: 0,
    reviews: 0,
    interrupted: false,
    session: '',
    command: [],
    changes: [],
    runId: 1,
  })
  const at = new Date(Date.parse(end) - 8_000).toISOString()
  // 子任务自己的对话（父对话里收进栏里，不在消息流平铺）
  const own = {
    id: 'demo-' + crypto.randomUUID(),
    role: 'agent' as const,
    agentId: agent.id,
    step: id,
    text: result,
    tools: [],
    at: end,
  }
  // 派出它的那条系统消息：消息流里不画卡片，折叠行上仍写着「派出 1 个子任务」
  const spawned = {
    id: 'demo-' + crypto.randomUUID(),
    role: 'system' as const,
    agentId: '',
    step: '',
    text: '「' + task.title + '」派出 1 个子角色：' + title,
    tools: [],
    at,
    spawned: [id],
  }
  const last = task.messages
    .map((m, i) => (m.role === 'agent' ? i : -1))
    .filter((i) => i >= 0)
    .at(-1)
  task.messages.splice(last ?? task.messages.length, 0, spawned, own)
}

/** 示例任务：用模拟执行一次性跑完，再把时间往前挪，看起来像之前做过的任务 */
/** 演示里的执行计划：一份做完带总结的，一份正在做（一步在等端到端测试，一步展开着子步骤） */
/**
 * 示例父对话的子对话：状态栏的计数、浮层的分组、消息流里的运行区都要有东西看。
 * 五个在转圈（状态栏上是 5/5）：三个在跑（其中两个的计划还没做完，在跑就算执行中、不归未完成）、
 * 一个在等后台命令、一个已标记解决但还在跑（「已完成」不能盖住还在跑）；另外三个已做完。
 * 进程活着的也是这五个，所以分母不会比分子少
 */
async function demoChildren(d: Db, parent: Task, agent: { id: string; name?: string }) {
  const plan = (done: number, total: number) => ({
    id: 'p1',
    title: '修复角标不刷新',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    doneAt: '',
    summary: '',
    autoSummary: false,
    steps: Array.from({ length: total }, (_, i) => ({
      id: String(i + 1),
      title: `第 ${i + 1} 步`,
      status: (i < done ? 'done' : 'pending') as PlanStatus,
      note: '',
      waits: [],
      startedAt: '',
      endedAt: '',
      children: [],
    })),
  })
  const make = async (
    title: string,
    how: {
      working?: boolean
      alive?: boolean
      plan?: ReturnType<typeof plan>
      resolved?: boolean
      /** 塞一个还在跑的后台命令：CLI 在等结果，/children 的 background 和 waiting 都读它 */
      job?: boolean
      /** 这个后台命令挂在子任务（slot='sub'）名下：运行区要能显示「子任务 + 命令名」 */
      subJob?: boolean
    } = {},
  ) => {
    const { task, done } = createTask(
      d,
      {
        projectId: parent.projectId,
        mode: 'chat',
        parentTaskId: parent.id,
        workflowId: '',
        agentId: agent.id,
        prompt: title,
        attachments: [],
        cli: '',
        model: '',
        effort: '',
        params: {},
        askUser: false,
      },
      true,
    )
    await done
    // 执行过程中任务可能被换成新对象，按 id 取回来再改
    const it = d.tasks?.find((x) => x.id === task.id) ?? task
    it.title = title
    it.working = !!how.working
    it.resolved = !!how.resolved
    // 第一条要求是父对话交代的：子对话里画成「接收消息 · 交代任务」
    if (it.messages[0])
      it.messages[0].peer = {
        id: parent.id,
        title: parent.title,
        name: '统筹',
        rel: 'parent',
        kind: 'task',
        subject: title,
      }
    // 做完的子对话给父对话交回一条状态：父对话里画成「接收消息 · 汇报」
    if (how.resolved)
      parent.messages.push({
        id: `${it.id}-report`,
        role: 'system',
        agentId: '',
        step: '',
        text: `【子对话状态】「${title}」（id ${it.id}）已完成：合回原分支、标记完成`,
        tools: [],
        panel: 'child',
        child: { id: it.id, title, state: 'done' },
        peer: {
          id: it.id,
          title,
          name: agent.name ?? title,
          rel: 'child',
          kind: 'report',
          subject: '已完成：合回原分支、标记完成',
        },
        at: new Date().toISOString(),
      })
    if (how.plan) it.plans = [how.plan]
    // 后台命令跑在服务端，CLI 只是等结果：这一轮没在跑也还没做完（归「执行中」）
    if (how.job) {
      // 挂在子任务上的命令：运行区按「子任务 + 后台命令名」列，演示里也要有一条能看的
      // （id 取没被占用的：模拟执行时已经派过 @chat/sub/h1、h2）
      let subId = ''
      if (how.subJob) {
        const used = new Set(it.steps.map((s) => s.id))
        let n = 1
        while (used.has(`@chat/sub/h${n}`)) n++
        subId = `@chat/sub/h${n}`
        it.steps.push({
          id: subId,
          parentId: '@chat',
          slot: 'sub',
          round: 0,
          workflowId: '',
          flowId: '',
          nodeId: '',
          kind: 'agent',
          title: '核对限流规则',
          agentId: agent.id,
          status: 'running',
          startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          endedAt: '',
          spentMs: 0,
          waitMs: 0,
          waitStartedAt: '',
          output: '',
          verdict: '',
          rounds: 0,
          reruns: 0,
          reviews: 0,
          interrupted: false,
          session: '',
          command: [],
          changes: [],
          runId: 1,
        })
      }
      it.jobs = [
        {
          id: `job-${it.id}`,
          ...(subId ? { step: subId } : {}),
          name: '端到端测试',
          command: 'npm run test:e2e',
          state: 'running' as const,
          startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        },
      ]
    }
    // 进程还活着（cliAlive）：演示里没有真的进程，用 live 登记一下
    if (how.alive) live.set(it.id, { stop: false })
    return it
  }
  await make('Git+worktree 不再提示文件撞车', { working: true, alive: true })
  await make('内存面板增加 AI 分析', { working: true, alive: true, plan: plan(1, 2) })
  await make('子任务卡片移到子对话那一栏', { working: true, alive: true, plan: plan(1, 2) })
  // 在等后台命令：这一轮没在跑，但命令还在跑，运行区和弹层都要列出来；命令挂在子任务名下
  await make('整理 ESLint 规则', { alive: true, job: true, subJob: true })
  // 已标记解决但还在跑：完成标记不能盖住还在跑
  await make('压测导入大文件', { working: true, alive: true, resolved: true })
  await make('修侧栏时间显示', { resolved: true })
  await make('核对通知时序', { resolved: true })
  await make('拆分规则检查脚本', { resolved: true })
  // 请用户决定的子对话：一次问了两个问题，子对话页的输入框换成选择弹窗，父对话里是两张提问卡片
  {
    const asker = await make('购物车缓存方案')
    // 父对话开着「提问」才把子对话的提问交给用户：关着时卡片不出现，交给父对话的 AI 决定
    parent.askUser = true
    const qs = [
      { q: '购物车数量用哪种缓存？', options: ['内存缓存', 'localStorage'] },
      { q: '缓存多久失效？', options: ['5 分钟', '切页面时刷新'] },
    ]
    asker.parentAsks = qs.map((x, i) => {
      const id = `${asker.id}-ask${i + 1}`
      parent.messages.push({
        id,
        role: 'system',
        agentId: '',
        step: '',
        text: x.q,
        tools: [],
        panel: 'ask',
        ask: { from: asker.id, title: asker.title, question: x.q, options: x.options, kind: 'question' },
        at: new Date().toISOString(),
      })
      return { id, question: x.q, options: x.options, kind: 'question' as const }
    })
  }
  // 父对话给子任务传话（send_message）：发件方画成一行「发送消息 · 传话」，不再把整段正文铺成居中的系统块
  parent.messages.push({
    id: 'demo-send-message',
    role: 'agent',
    agentId: agent.id,
    step: '',
    text: '',
    tools: [
      {
        kind: 'other',
        name: 'mcp__panel__send_message',
        label: '传话',
        detail: '',
        input: '{"to":"核对通知时序","text":"接口改名了，这边先按新名字改，改完告诉我。"}',
        output: '已放进「核对通知时序」的收件箱，它用 read_messages 能看到',
      },
    ],
    at: new Date().toISOString(),
  })
  // 旧记录：同一段话逐个交给了几个子对话（现在面板会拒绝），界面合成一行「发送消息 · 交代任务 · 发给 3 个」
  const rule = '【用户刚定的硬规则】截图失败就不下视觉结论，把看起来不对的地方写成待验证项。'
  parent.messages.push({
    id: 'demo-send-same',
    role: 'agent',
    agentId: agent.id,
    step: '',
    text: '',
    tools: (d.tasks ?? [])
      .filter((x) => x.parentTaskId === parent.id)
      .slice(0, 3)
      .map((k) => ({
        kind: 'other' as const,
        name: 'MCP',
        label: 'panel · send_to_conversation',
        detail: '',
        input: JSON.stringify({ id: k.id, message: rule }),
        output: `「${k.title}」子对话正在执行，已实时送达`,
        ms: 100,
      })),
    at: new Date().toISOString(),
  })
}

function demoPlans(task: Task) {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  const item = (id: string, title: string, status: PlanStatus, start = 0, end = 0) => ({
    id,
    title,
    status,
    note: '',
    waits: [],
    startedAt: start ? at(start) : '',
    endedAt: end ? at(end) : '',
  })
  task.plans = [
    {
      id: 'p1',
      title: '定位角标不刷新的原因',
      createdAt: at(40),
      doneAt: at(30),
      summary:
        '角标读的是首次渲染时的购物车快照，加购后没有订阅 `cart:changed` 事件。已确认问题在 `CartBadge.tsx`，修复放到下一份计划里做。',
      autoSummary: false,
      steps: [
        { ...item('1', '复现：连续加购三次看角标', 'done', 40, 37), children: [] },
        { ...item('2', '找出角标的数据来源', 'done', 37, 30), children: [] },
      ],
    },
    {
      id: 'p2',
      title: '修复购物车角标',
      createdAt: at(28),
      doneAt: '',
      summary: '',
      autoSummary: false,
      steps: [
        { ...item('1', '角标订阅购物车变化', 'done', 28, 20), children: [] },
        {
          ...item('2', '跑端到端测试', 'waiting', 20),
          waits: [{ kind: 'background', ref: 'e2e01', label: '端到端测试', state: 'waiting' }],
          children: [],
        },
        {
          ...item('3', '补上加购后的单元测试', 'running', 18),
          children: [
            item('3.1', '覆盖连续加购', 'done', 18, 12),
            item('3.2', '覆盖删除商品后角标归零', 'running', 12),
            item('3.3', '覆盖未登录的本地购物车', 'pending'),
          ],
        },
        { ...item('4', '整理改动和总结', 'pending'), children: [] },
      ],
    },
  ]
}

/**
 * 演示任务的用量：几轮分散在最近十几天（故意空出两天），日历上能看到有数据的日子，
 * 按周、按月也有数。演示里本来没有 turns，不补的话用量统计永远是空的。
 * 金额按美元记在 usage 上，只当 CLI 上报的费用作对照；表格里的费用按计价模型实时折算。
 */
function seedDemoUsage(task: Task, minutes: number) {
  if (task.turns?.length) return
  // 任务的「最近一天」：createdAt 已经按 back() 的偏移移过，不会再被重复改
  const last = new Date(new Date(task.createdAt).getTime() + minutes * 60_000)
  const turns: TaskTurn[] = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  for (let i = 0; i < 12; i++) {
    // 隔几天空一天：日历上的点不必连成一片
    if (i === 5 || i === 9) continue
    const day = new Date(last.getFullYear(), last.getMonth(), last.getDate() - i)
    const startedAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10 + (i % 7), 12 + i)
    const input = 320_000 + i * 41_000
    const output = 26_000 + i * 3_100
    const cacheRead = Math.round(input * 0.62)
    const cacheWrite = Math.round(input * 0.08)
    usage.inputTokens += input
    usage.outputTokens += output
    usage.cacheReadTokens += cacheRead
    usage.cacheWriteTokens += cacheWrite
    usage.costUsd += 0.42 + i * 0.03
    turns.push({
      id: `demo-turn-${task.id.slice(-8)}-${i}`,
      title: '',
      agentId: '',
      status: 'done',
      startedAt: startedAt.toISOString(),
      endedAt: new Date(startedAt.getTime() + 90_000).toISOString(),
      from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      waitMs: 0,
    })
  }
  task.turns = turns
  task.usage = { ...(task.usage ?? {}), ...usage, agents: task.usage?.agents ?? {} }
}

async function seedTasks(d: Db) {
  const [shop, admin] = d.projects
  const fe = d.agents.find((a) => a.name === '前端开发')
  const back = (t: Task, minutes: number) => {
    const shift = (iso: string) => new Date(new Date(iso).getTime() - minutes * 60_000).toISOString()
    t.createdAt = shift(t.createdAt)
    t.updatedAt = shift(t.updatedAt)
    t.messages.forEach((m) => (m.at = shift(m.at)))
    // 启动命令：演示里没有真的跑 CLI，写一条像样的，署名行最右边能点开看
    const argv = [
      'claude',
      '--model',
      'claude-sonnet-5-5',
      '--permission-mode',
      'acceptEdits',
      '-p',
      t.title.slice(0, 40),
    ]
    t.command = argv
    t.steps.forEach((s) => {
      if (s.startedAt) s.command = argv
    })
    // 示例任务是瞬间跑完的，给一个像样的执行时长
    if (t.status !== 'running') {
      t.runMs = (2 + (minutes % 7)) * 60_000 + 23_000
      spreadSteps(t)
    }
    seedDemoUsage(t, minutes)
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
    demoPlans(task)
    back(task, 60 * 3)
    demoHelper(task, fe)
    await demoChildren(d, task, fe)
    // 这个对话改过两个文件：「改动」Tab 和差异窗口（含上一个/下一个导航）都要有东西看
    task.changes = [
      { path: 'src/components/CartBadge.tsx', add: 5, del: 3 },
      { path: 'src/components/RestockButton.tsx', add: 9, del: 0 },
    ]
    persist()
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
  // Chat 模式（不属于任何项目）的聊天：侧栏按天分组，演示里留两条不同日期的
  if (fe) {
    const chats = [
      { prompt: '整理一份 Claude Code 和 Codex 的能力对照', minutes: 60 * 3 },
      { prompt: '排查：侧栏任务的时间显示偶尔不对', minutes: 60 * 26 },
    ]
    for (const c of chats) {
      const { task, done } = createTask(
        d,
        {
          projectId: '',
          mode: 'chat',
          workflowId: '',
          agentId: fe.id,
          prompt: c.prompt,
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
      if (c.minutes > 60 * 24) demoAlerts(task)
      back(task, c.minutes)
    }
  }
}

/** 对话里的报错和警告长什么样：一条已恢复的网络断开、一条 CLI 没有响应、一条额度用完（见 shared/alerts.ts） */
function demoAlerts(task: Task) {
  const at = new Date().toISOString()
  const note = (text: string, alert: TaskMessage['alert']): TaskMessage => ({
    id: `demo-${crypto.randomUUID()}`,
    role: 'system',
    agentId: '',
    step: '',
    text,
    tools: [],
    alert,
    at,
  })
  task.messages.push(
    note('Claude Code 执行失败：\n· 和模型服务的连接中途断开了。\n\n正在自动续接会话重试（第 1/2 次）…', {
      kind: 'network',
      level: 'warn',
      detail: 'API Error: Stream connection failed mid-response: terminated',
      resolved: '已自动续接，从中断的地方继续了',
    }),
    note('Claude Code 收到消息 90 秒了还没有任何输出。直接再发一条消息，面板会停掉它、接回这个会话重新开始。', {
      kind: 'no_response',
      level: 'warn',
      detail:
        'Claude Code 在 90 秒里没有任何输出（没有思考、正文或工具调用）。\n交给它的最后一条内容：\n后台命令「等待 CI」跑完了：成功',
    }),
    note('Claude Code 执行失败（退出码 1）：', {
      kind: 'quota',
      level: 'error',
      detail: 'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Insufficient balance"}}',
    }),
  )
}

/**
 * 版本更新：在线演示直接从浏览器读 GitHub Releases（接口允许跨域），当作最新发布的版本；不能安装。
 */
async function demoApp(url: string): Promise<unknown> {
  if (url.startsWith('/app/install') || url.startsWith('/app/rollback')) fail('在线演示不能安装，可以下载包到本机运行')
  // 演示里不会真的强制更新，也就没有被打断的任务
  if (url.startsWith('/app/interrupted')) return { at: '', acknowledged: false, tasks: [] } satisfies InterruptedTasks
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
    checkedAt: new Date().toISOString(),
    releases: list.slice(0, 5),
    update: pickUpdate(current, list),
  } satisfies AppReleases
}
