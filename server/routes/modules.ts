/**
 * 模块清单：server/index.ts 里以前一行一个的 app.route('/x', xApi())，按原来的挂载顺序收在这里（约定见 ./module.ts）。
 * 分成三段，是因为中间夹着 server/index.ts 自己写的几组接口（设置、角色 / 工作流 / 项目、本地目录），
 * 三段和那几组在 server/index.ts 的一张清单里按原顺序交错挂载：Hono 按登记顺序匹配，同前缀的几组（/clis、/tasks、/app）不能换位置
 */
import type {
  Agent,
  AgentInput,
  Category,
  CategoryInput,
  Project,
  ProjectInput,
  Workflow,
  WorkflowInput,
} from '../../shared/schema.ts'
import { SummaryConfig, type SummaryRecord, type SummaryReport } from '../../shared/summary/index.ts'
import type { LessonDraftInput, LessonDraftRecord } from '../../shared/lesson-draft.ts'
import { type createCollection, dataPath, readJson, writeJsonAtomic } from '../store.ts'
import type { ApiModule } from './module.ts'
import { extraModules } from './extras.ts'
import { accountsApi } from '../accounts.ts'
import { apiSpeedApi } from '../cli/api-speed.ts'
import { integrationsApi } from '../integrations.ts'
import { hooksApi } from '../hooks/api.ts'
import { configScanApi } from '../config-scan.ts'
import { libraryApi } from '../library.ts'
import { mcpApi } from '../mcp-store.ts'
import { projectMcpApi } from '../projects/mcp.ts'
import { toggleCapability } from '../../shared/projects/capabilities.ts'
import { trustApi } from '../cli/trust-api.ts'
import { docRootOf } from '../module-map.ts'
import { installApi } from '../install.ts'
import { envApi } from '../env-api.ts'
import { modelsApi } from '../models.ts'
import { packagesApi } from '../cli/packages.ts'
import { modelCatalogApi } from '../cli/model-catalog.ts'
import { itemTrashRoutes } from '../item-trash.ts'
import type { tasksApi } from '../tasks/index.ts'
import { summaryApi } from '../summary/index.ts'
import { lessonDraftsApi } from '../lesson-drafts.ts'
import type { schedulesApi } from '../schedules.ts'
import { runUsageApi } from '../run-usage.ts'
import { taskMemoryApi } from '../tasks/memory.ts'
import { usageApi } from '../usage.ts'
import { assistApi } from '../assist.ts'
import { stylesApi } from '../styles.ts'
import { browserExtApi } from '../browser-ext-routes.ts'
import { bridgeApi } from '../bridge.ts'
import { asksApi } from '../asks.ts'
import { pluginsApi } from '../plugins/index.ts'
import { mcpCatalogApi } from '../mcp-catalog/index.ts'
import { askMcpApi } from '../ask-mcp.ts'
import type { docsApi } from '../docs/index.ts'
import { fixApi } from '../fix.ts'
import { projectSkillsApi } from '../projects/skills.ts'
import { projectCapabilitiesApi } from '../projects/capabilities.ts'
import { deployApi } from '../deploy.ts'
import { webViewApi } from '../web-view/index.ts'
import { findInstalled } from '../plugins/manager.ts'
import { serviceOrigin, touchService } from '../plugins/services.ts'
import { uploadsApi, uploadsRawApi } from '../uploads.ts'
import { filesApi } from '../files.ts'
import type { memorySampler } from '../memory.ts'
import { dataApi } from '../data.ts'
import { cleanupApi } from '../cleanup.ts'
import type { updateApi } from '../update/index.ts'
import { pageEventsApi } from '../page-events.ts'
import { appActionsApi } from '../app-actions/index.ts'
import { interruptedApi } from '../interrupted.ts'
import { remoteApi } from '../remote.ts'

type Collection<I extends object, T extends I & { id: string; createdAt: string; updatedAt: string }> = ReturnType<
  typeof createCollection<I, T>
>

/** 各组接口要用的、在 server/index.ts 里建好的对象 */
export interface ModuleDeps {
  agents: Collection<AgentInput, Agent>
  categories: Collection<CategoryInput, Category>
  workflows: Collection<WorkflowInput, Workflow>
  projects: Collection<ProjectInput, Project>
  summaries: Collection<SummaryReport, SummaryRecord>
  lessonDrafts: Collection<LessonDraftInput, LessonDraftRecord>
  tasks: ReturnType<typeof tasksApi>
  schedules: ReturnType<typeof schedulesApi>
  docs: ReturnType<typeof docsApi>
  memory: ReturnType<typeof memorySampler>
  updater: ReturnType<typeof updateApi>
}

/** CLI、账号、集成、MCP、模型这一段：挂在「设置、CLI 配置」之后，「CLI 额度、角色、工作流、项目」之前 */
export function toolModules({ projects, agents }: Pick<ModuleDeps, 'projects' | 'agents'>): ApiModule[] {
  const projectPath = async (id: string) => (await projects.get(id))?.path ?? ''
  // 项目 MCP 导入后在这个项目里打开：读最新的项目记录再改，只动 capabilities.mcp
  const enableMcp = async (id: string, names: string[]) => {
    const p = id ? await projects.get(id) : undefined
    if (!p) return
    let caps = p.capabilities
    for (const n of names) caps = toggleCapability(caps, 'mcp', n, true)
    if (JSON.stringify(caps) === JSON.stringify(p.capabilities)) return
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = p
    await projects.update(id, { ...rest, capabilities: caps })
  }
  return [
    { prefix: '/accounts', app: accountsApi() },
    { prefix: '/accounts', app: apiSpeedApi() },
    { prefix: '/integrations', app: integrationsApi() },
    { prefix: '/hooks', app: hooksApi({ projects, agents }) },
    { prefix: '/config-scan', app: configScanApi() },
    { prefix: '/library', app: libraryApi() },
    { prefix: '/mcp-tools', app: mcpApi() },
    // 项目设置里的 MCP：项目目录里识别到的配置，项目目录按 projectId 现取
    { prefix: '/project-mcp', app: projectMcpApi({ projectPath, enableMcp }) },
    { prefix: '/project-trust', app: trustApi({ projectPath }) },
    { prefix: '/clis', app: installApi() },
    // 本机生图、语音输入 / 朗读、Chat 记忆：各自一组的子路由（./extras.ts）
    ...extraModules({ projects }),
    { prefix: '/', app: envApi() },
    { prefix: '/clis', app: modelsApi() },
    { prefix: '/clis', app: packagesApi({ projectPath }) },
    { prefix: '/model-catalog', app: modelCatalogApi() },
  ]
}

/** 回收站、对话、总结、计划、助手、扩展、文档、附件这一段：挂在「项目」之后，「本地目录」之前 */
export function workModules(d: Omit<ModuleDeps, 'memory' | 'updater'>): ApiModule[] {
  const { agents, categories, workflows, projects, summaries, lessonDrafts, tasks, schedules, docs } = d
  // 工作总结的配置：面板里加过的项目
  const summaryConfigFile = dataPath('config/summary.json')
  return [
    // 角色、工作流、项目的回收站（对话的回收站在 /tasks/trash）
    {
      prefix: '/trash/items',
      app: itemTrashRoutes({ agents, workflows, projects, restoreTasks: (ids) => tasks.restoreTasks(ids) }),
    },
    { prefix: '/tasks', app: tasks.routes },
    // 工作总结：按天 / 按周提炼分项，采纳后拼成报告（只读任务记录，不改项目文件）
    {
      prefix: '/summary',
      app: summaryApi({
        tasks,
        projects,
        agents,
        reports: summaries,
        // 面板里加过的项目：读坏了按空的来，页面照常能加
        config: {
          get: async () => SummaryConfig.catch({ projectIds: [] }).parse((await readJson(summaryConfigFile)) ?? {}),
          set: (c) => writeJsonAtomic(summaryConfigFile, c),
        },
      }).routes,
    },
    { prefix: '/lesson-drafts', app: lessonDraftsApi({ drafts: lessonDrafts, reports: summaries }).routes },
    // 定时计划：到点由面板自己新建一个对话，走和页面新建任务完全一样的链路
    { prefix: '/schedules', app: schedules.routes },
    // 整个运行的用量（父对话 + 所有子对话 + 派出的子任务）：子对话不在任务列表里，只能服务端算
    { prefix: '/tasks', app: runUsageApi({ tasks }).routes },
    // 会话内存的 AI 分析：采样序列 + 进程面板两路 + 任务树规模，整理成交给本机 CLI 的报告
    {
      prefix: '/tasks',
      app: taskMemoryApi({
        tasks,
        panel: (id) => tasks.processPanel(id),
        projects,
      }).routes,
    },
    // 设置页的用量统计：按天 / 周 / 月聚合各任务每轮执行的 token
    { prefix: '/usage', app: usageApi({ tasks }).routes },
    { prefix: '/assist', app: assistApi({ agents, categories, workflows, projects }) },
    // ---- 风格库和连接浏览器的扩展（UI 设计本身在 UI 设计插件里，fixcode-h/agent-plugins 的 ui-design）----
    { prefix: '/styles', app: stylesApi() },
    // 浏览器扩展（扩展是面板的，借网页版图片模型出图；以前挂在设计接口下，地址不变）
    { prefix: '/designs/browser', app: browserExtApi() },
    { prefix: '/bridge', app: bridgeApi() },
    { prefix: '/asks', app: asksApi() },
    { prefix: '/plugins', app: pluginsApi() },
    {
      prefix: '/mcp-catalog',
      app: mcpCatalogApi({ agents, projects, taskTitle: async (id) => (await tasks.get(id))?.title ?? '' }),
    },
    { prefix: '/mcp', app: askMcpApi() },
    { prefix: '/project-docs', app: docs.routes },
    { prefix: '/doc-jobs', app: docs.jobRoutes },
    { prefix: '/ai-fix', app: fixApi() },
    // 项目设置里的 Skill 分节：项目目录下的技能
    { prefix: '/project-skills', app: projectSkillsApi({ projects }) },
    // 项目「能力」页：按项目生效的插件、推荐理由和还缺的设置（插件接口 9）
    { prefix: '/project-capabilities', app: projectCapabilitiesApi() },
    { prefix: '/deploy', app: deployApi({ startDoc: docs.start }) },
    // 网页页签：本机文件换沙箱地址、外部网址预检、阅读模式（ADR 0068）
    {
      prefix: '/web-view',
      app: webViewApi({
        workDir: tasks.workDir,
        projectDir: async (id) => (await projects.get(id))?.path ?? '',
        docRoot: async (id) => {
          const p = await projects.get(id)
          return p?.path ? docRootOf(p.path, await agents.list()) : ''
        },
        outsideFiles: async (id) => ((await tasks.get(id))?.outsideChanges ?? []).map((c) => c.path),
        pluginDir: (id) => findInstalled(id)?.dir ?? '',
        serviceOrigin,
        touchService,
      }),
    },
    // ---- 附件和 @ 引用的项目文件 ----
    { prefix: '/uploads/raw', app: uploadsRawApi() },
    {
      prefix: '/uploads',
      app: uploadsApi({
        dirs: async () => (await projects.list()).map((p) => p.path).filter(Boolean),
        known: (file) => tasks.hasAttachment(file),
      }),
    },
    // 文件浏览页：项目里的文件树、内容搜索、看单个文件
    { prefix: '/project-files', app: filesApi({ projects }) },
  ]
}

/** 数据、更新、页面事件、动作表、外网访问这一段：挂在「本地目录」之后，是清单的最后一段 */
export function systemModules({ tasks, projects, memory, updater }: ModuleDeps): ApiModule[] {
  return [
    { prefix: '/data', app: dataApi({ running: () => tasks.running(), memory }) },
    // 逐个目录 stat / 跑 git 的清理入口单独一块（/data/cleanup*），不和上面那套按分类扫路径的混在一起
    { prefix: '/data/cleanup', app: cleanupApi({ tasks, projects }) },
    { prefix: '/app', app: updater.api },
    { prefix: '/app', app: pageEventsApi() },
    // 操控软件的动作表（见 ADR 0011）：Agent 经 MCP 调，人和脚本经 /api/actions 调；
    // 动作进程内调这些接口，和界面点按钮走同一段代码（setActionHost 在 server/index.ts）
    { prefix: '/actions', app: appActionsApi() },
    // 新版本启动后问用户要不要继续被上次强制更新打断的任务
    {
      prefix: '/app',
      app: interruptedApi({
        ready: () => tasks.ready(),
        getTask: (id) => tasks.get(id),
        projectName: async (id) => (await projects.get(id))?.name ?? '',
      }),
    },
    { prefix: '/remote', app: remoteApi() },
  ]
}
