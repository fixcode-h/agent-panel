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
import { createInterface } from 'node:readline'
import { z } from 'zod'
import {
  Agent,
  LEGACY_DEFAULT_AGENT_ID,
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
import { ProjectProposalSchema } from '../shared/project-init.ts'
import { extensionSelfReload } from '../shared/design.ts'
import { createCollection, DATA_DIR, migrateDataDir } from './store.ts'
import { dataApi } from './data.ts'
import { memorySampler } from './memory.ts'
import { tasksApi } from './tasks.ts'
import { taskMemoryApi } from './task-memory.ts'
import { usageApi } from './usage.ts'
import { runUsageApi } from './run-usage.ts'
import { assistApi } from './assist.ts'
import { designsApi } from './designs.ts'
import { designMcpApi } from './design-mcp.ts'
import { askMcpApi } from './ask-mcp.ts'
import { askExtensionReload, bridgeApi, browserStatus, extensionDir, openExtensionsPage } from './bridge.ts'
import { docsApi } from './docs.ts'
import { fixApi } from './fix.ts'
import { projectSkillsApi } from './project-skills.ts'
import { isPanelSource } from './panel-source.ts'
import { deployApi } from './deploy.ts'
import { detectClis } from './detect.ts'
import { accountsApi, syncCliAuths } from './accounts.ts'
import { integrationsApi } from './integrations.ts'
import { installApi } from './install.ts'
import { comfyApi } from './comfy.ts'
import { libraryApi } from './library.ts'
import { mcpApi } from './mcp-store.ts'
import { projectMcpApi } from './project-mcp.ts'
import { openBrowser, revealDir, revealItem } from './open.ts'
import { modelsApi } from './models.ts'
import { modelCatalogApi } from './model-catalog.ts'
import { getLimits, isSharedSkill, listSkills } from './cli-extras.ts'
import { packagesApi } from './cli-packages.ts'
import { interruptedApi } from './interrupted.ts'
import { appDir, cleanupOldTray, currentVersion, restartProcess, updateApi } from './update.ts'
import { pageEventsApi, parseTrayCommand, signalPages } from './page-events.ts'
import { appActionsApi, setActionHost } from './app-actions/index.ts'
import { callApi } from './app-actions/registry.ts'
import { getSettings, saveSettings } from './settings.ts'
import { setPresenceReclaimPolicy } from './presence.ts'
import { GlobalLessons, Settings } from '../shared/schema.ts'
import { cycleText, includeCycle } from '../shared/agent-role.ts'
import { inspectDir, listDir, makeDir, resolvePath } from './fs.ts'
import { gitBranches, gitCheckout } from './exec/git.ts'
import { sweepWorktrees } from './exec/worktree.ts'
import { killAllProcesses, killTree } from './exec/process.ts'
import { cleanStaleCliProcesses } from './exec/orphans.ts'
import { startMemorySampler } from './exec/proc-stats.ts'
import { listCommands } from './slash.ts'
import { searchProjectFiles, uploadsApi, uploadsRawApi } from './uploads.ts'
import { filesApi } from './files.ts'
import { t } from '../shared/i18n.ts'
import { defaultWorkflow } from '../shared/builtin/default.ts'
import { agentDeleteError, checkWorkflow, workflowDeleteError } from '../shared/validate.ts'
import { builtinDefinition, builtinKey, isBuiltinAgent, isCoreAgent, syncCore } from '../shared/builtin/core.ts'
import {
  builtinProjectCategories,
  isBuiltinProjectCategory,
  projectCategoryDeleteError,
} from '../shared/builtin/project-categories.ts'
import {
  ensureProjectAgents,
  migrateProjectsToGeneral,
  pruneMergedAgents,
  redirectMergedProjects,
  redirectWorkflowRefs,
  retiredWorkflows,
  seedProjectWorkflows,
} from '../shared/builtin/install.ts'
import { loadSeededWorkflows, saveSeededWorkflows } from './builtin-seeded.ts'
import { addAgentAliases, backupRemovedAgents, loadAgentAliases } from './agent-aliases.ts'
import { analyzeProject } from './projects-analyze.ts'
import { orderProjects, projectOrderError, sortProjects } from '../shared/project-order.ts'
import { grantCookie, tokenGuard, withToken } from './auth.ts'
import { hostOf, isAllowedHost, isLocalHost } from './hosts.ts'
import { applyRemote, configureRemote, remoteApi, stopRemote } from './remote.ts'
import { installLogging, log, logFile } from './log.ts'
import { sweepPanelMcp } from './panel-mcp-files.ts'
import { existsSync } from 'node:fs'
import { detectShells, currentShell } from './shells.ts'
import { projectLessons, readGlobalLessons, writeGlobalLessons, type LessonDraft } from './lessons.ts'
import { LESSON_REVIEW_LANG, parseLessonReview } from '../shared/lesson-review.ts'

// 更新时旧版本用这个参数试加载新的 server.mjs：模块都能加载就说明这台电脑的 Node 能跑，不动数据、不监听端口
if (process.argv.includes('--self-check')) process.exit(0)
installLogging()

// 先把旧版本的数据搬到用户目录的新结构，后面的集合才读得到
migrateDataDir()
// 删掉的角色该转到哪个：要在读工作流、对话之前装上，读出来的旧引用才会被改写
loadAgentAliases()
// 上次面板被强杀（taskkill /F、崩溃）时来不及停的 CLI：按登记文件 + 命令行特征清理，
// 用户自己跑的 pi、codex 命令行里没有面板的痕迹，不会动
void cleanStaleCliProcesses(killTree)

const agents = createCollection<AgentInput, Agent>('agents.json', Agent)
const categories = createCollection<CategoryInput, Category>('categories.json', Category)
const tags = createCollection<TagInput, Tag>('tags.json', Tag)
/** 只留存在的标签（标签删掉后，前端还没刷新时可能带着旧 id） */
const knownTags = async (ids: string[]) => {
  const all = new Set((await tags.list()).map((x) => x.id))
  return ids.filter((id) => all.has(id))
}
const workflows = createCollection<WorkflowInput, Workflow>('workflows.json', Workflow, () => [defaultWorkflow()])
const projectCategories = createCollection<ProjectCategoryInput, ProjectCategory>(
  'project-categories.json',
  ProjectCategory,
  builtinProjectCategories,
)
const projects = createCollection<ProjectInput, Project>('projects.json', Project)

/** 各项目目录里面板没来得及删的 MCP 条目（关掉、崩溃时留下的）：启动时还没有在跑的对话，凡是指向本面板的都已失效 */
async function sweepProjectsPanelMcp() {
  for (const p of await projects.list().catch(() => [])) {
    if (!p.path || !existsSync(p.path)) continue
    const n = await sweepPanelMcp(p.path)
    if (n) log.info('server', '清掉了项目里失效的面板 MCP 条目', { project: p.name, files: n })
  }
}

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

/**
 * 自带工作流启动时默认全部加入（装过一次、后来被删掉的不再装回来，「通用项目」「UE 项目」缺了就补），
 * 旧项目没指定工作流的指向「通用项目」，之后改项目设置也不影响已经开始的对话（任务里存了快照）。
 */
async function ensureProjectWorkflows() {
  await removeLegacyDefaultAgent()
  const before = await loadSeededWorkflows()
  const seeded = await seedProjectWorkflows(
    {
      agents: await agents.list(),
      categories: await categories.list(),
      tags: await tags.list(),
      workflows: await workflows.list(),
    },
    {
      createAgent: (input) => agents.create(input),
      createCategory: (name, scope) => categories.create({ name, scope }),
      createTag: (input) => tags.create(input),
      createWorkflow: (input) => workflows.create(input),
      updateWorkflow: (id, input) => workflows.update(id, input),
      updateAgent: (id, input) => agents.update(id, input),
    },
    before,
  )
  if (seeded.seeded.join() !== before.join()) await saveSeededWorkflows(seeded.seeded)
  if (seeded.created.length) log.info('workflow', '已安装自带工作流', { list: seeded.created.map((w) => w.name) })
  if (seeded.updated.length) log.info('workflow', '已升级旧的内置工作流', { list: seeded.updated.map((w) => w.name) })
  if (seeded.upgradedAgents.length)
    log.info('agent', '内置角色已换成当前版本', { list: seeded.upgradedAgents.map((a) => a.name) })
  if (seeded.replaced.length) {
    const file = await backupRemovedAgents(seeded.replaced, '内置角色换成了新版本，这是覆盖前你改过的版本')
    log.info('agent', '内置角色里你改过的设定已备份后覆盖', { list: seeded.replaced.map((a) => a.name), file })
  }
  await retireWorkflows()
  await pruneMerged()
  // 已有「通用项目」时不会重新 build 工作流，协调 Agent / 任务 Agent 可能还没建出来
  const projectAgents = await ensureProjectAgents(
    {
      agents: await agents.list(),
      categories: await categories.list(),
      tags: await tags.list(),
      workflows: await workflows.list(),
    },
    {
      createAgent: (input) => agents.create(input),
      createCategory: (name, scope) => categories.create({ name, scope }),
      createTag: (input) => tags.create(input),
      createWorkflow: (input) => workflows.create(input),
      updateWorkflow: (id, input) => workflows.update(id, input),
      updateAgent: (id, input) => agents.update(id, input),
    },
  )
  if (projectAgents.created.length)
    log.info('agent', '已安装必备角色', { list: projectAgents.created.map((a) => a.name) })
  if (projectAgents.synced.length)
    log.info('agent', '必备角色已按内置定义同步', { list: projectAgents.synced.map((a) => a.name) })
  const coordinator = (await agents.list()).find((a) => a.origin === 'builtin:orchestrator')
  const migrations = await migrateProjectsToGeneral(
    await projects.list(),
    await workflows.list(),
    await projectCategories.list(),
  )
  for (const m of migrations) {
    const p = await projects.get(m.id)
    if (p) await projects.update(m.id, { ...p, workflowId: m.workflowId })
  }
  if (migrations.length) log.info('project', '旧项目指向「通用项目」', { n: migrations.length })
  // 升级前没有「默认对话 Agent」这个设置：自动指向协调 Agent；用户设过「无」的（agentSet）不再覆盖
  if (coordinator) {
    let n = 0
    for (const p of await projects.list()) {
      if (p.agentSet) continue
      await projects.update(p.id, { ...p, defaultAgentId: coordinator.id, agentSet: true })
      n++
    }
    if (n) log.info('project', '旧项目默认使用协调 Agent', { n })
  }
}
/**
 * 以前自带的「默认 Agent」去掉了：不用角色就是直接用 CLI，引用它的旧数据读出来已经改成空（见 schema 的 dropLegacyAgent）。
 * 用户改过它的名字或设定时先备份一份再删。
 */
async function removeLegacyDefaultAgent() {
  const old = await agents.get(LEGACY_DEFAULT_AGENT_ID)
  if (!old) return
  if (old.instructions.trim() || old.includes.length || old.params.length) {
    const file = await backupRemovedAgents([old], '默认 Agent 去掉了：不用角色就是直接用 CLI')
    log.info('agent', '默认 Agent 改过设定，已备份', { file })
  }
  await agents.remove(old.id)
  log.info('agent', '已去掉默认 Agent，旧对话改为直接用 CLI')
}

/**
 * 合并掉的内置工作流（日常开发、UE 功能开发、项目初始化）：没改过的本机副本删掉，
 * 项目和项目分类里指向它的改指到接替的工作流；用户改过的副本留着。
 */
async function retireWorkflows() {
  const list = retiredWorkflows({ agents: await agents.list(), workflows: await workflows.list() })
  if (!list.length) return
  const moved = Object.fromEntries(list.map((r) => [r.workflow.id, r.into]))
  const refs = redirectWorkflowRefs(await projects.list(), await projectCategories.list(), moved)
  for (const p of refs.projects) await projects.update(p.id, p)
  for (const c of refs.categories) await projectCategories.update(c.id, c)
  for (const r of list) await workflows.remove(r.workflow.id)
  log.info('workflow', '已删除合并掉的内置工作流', { list: list.map((r) => r.workflow.name) })
}

/**
 * 合并掉的内置角色：工作流里的引用已经在 seedProjectWorkflows 里重定向了，这里再把项目的默认对话角色改过去，
 * 然后删掉没人用、也没改过的旧副本（先备份），旧对话里记着旧 id 的按登记的转到合并目标。
 */
async function pruneMerged() {
  const list = await agents.list()
  for (const m of redirectMergedProjects(await projects.list(), list)) {
    const p = await projects.get(m.id)
    if (p) await projects.update(m.id, { ...p, defaultAgentId: m.defaultAgentId })
  }
  const state = {
    agents: list,
    categories: await categories.list(),
    tags: await tags.list(),
    workflows: await workflows.list(),
  }
  const pruned = await pruneMergedAgents(state, await projects.list(), { deleteAgent: (id) => agents.remove(id) })
  if (!pruned.removed.length) return
  const file = await backupRemovedAgents(pruned.removed, '已合并到通用角色')
  await addAgentAliases(pruned.aliases)
  log.info('agent', '已删除合并掉的旧角色', { list: pruned.removed.map((a) => a.name), backup: file })
}

void ensureProjectWorkflows().catch((e) => log.warn('project', `安装项目工作流失败：${(e as Error).message}`))

const app = new Hono().basePath('/api')

/**
 * 只接受本机页面的请求。只监听 127.0.0.1 还不够：
 * - DNS 重绑定：恶意网页把自己的域名解析到 127.0.0.1，就能以「同源」身份调用接口 → 检查 Host
 * - 跨站请求：任意网页都能向 127.0.0.1 发 text/plain 的 POST（不触发预检）→ 检查 Origin，写操作必须是 JSON
 * 这些接口能启动本机 CLI、读写目录，被外部网页调用等于远程执行命令。
 */
app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? ''
  // 本机地址，或者当前开着的外网访问地址（见 remote.ts）
  if (!isAllowedHost(host)) return c.json({ error: t('只接受来自本机的访问') }, 403)
  const origin = c.req.header('origin')
  // 浏览器扩展只能调 /bridge 下面的接口（报标签页、取指令、交图片），别的一律不行
  if (/^(chrome|moz)-extension:\/\//.test(origin ?? '')) {
    if (!c.req.path.startsWith('/api/bridge/')) return c.json({ error: t('不接受其他网站发来的请求') }, 403)
    return next()
  }
  if (origin !== undefined) {
    let ok = false
    try {
      const from = new URL(origin)
      // 外网页面：Origin 必须是本机、当前外网地址，或者和请求的 Host 同源
      ok = isLocalHost(from.hostname) || from.hostname.toLowerCase() === hostOf(host) || isAllowedHost(from.hostname)
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

async function parseAgent(body: unknown, selfId = '') {
  const p = AgentInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  // 界面保存过能力开关：之后升级不再用内置默认值覆盖用户的选择
  if (body && typeof body === 'object' && ('canDelegate' in body || 'canPlan' in body)) p.data.capsSet = true
  // 引入：去掉自己和重复的；改了之后会绕回自己就拒绝，免得配置里留下死循环
  p.data.includes = [...new Set(p.data.includes)].filter((id) => id !== selfId)
  // 以前就有的循环（旧数据、导入的）不拦，不然连改个名字都存不了；配置页会把它提出来
  if (selfId && p.data.includes.length) {
    const list = await agents.list()
    const all = list.map((a) => (a.id === selfId ? { ...a, ...p.data } : a))
    const cycle = includeCycle({ id: selfId, includes: p.data.includes }, all)
    const before = list.find((a) => a.id === selfId)
    if (cycle.length && !(before && includeCycle(before, list).length))
      return { error: t('引入关系会形成循环：{chain}', { chain: cycleText(cycle, all) }) }
  }
  if (p.data.cli && !getCli(p.data.cli)) return { error: t('未知的 Agent：{cli}', { cli: p.data.cli }) }
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

// 端到端测试启动服务时会给一个分片唯一的标记（AGENT_PANEL_INSTANCE），这里回显它：
// 调用方（scripts/e2e/spawn-server.mjs）据此确认连上的是自己刚起的服务，
// 端口被残留进程或并行的分片占着时能立刻发现，不会等到第一个请求超时才看出假通过
app.get('/health', (c) => c.json({ ok: true, instance: process.env.AGENT_PANEL_INSTANCE ?? '' }))
// ---- 设置 ----
/** 回收策略跟着设置走：宽限、上限、总开关；保存后立即生效，不用重启服务 */
const applyPresenceReclaim = (s: Awaited<ReturnType<typeof getSettings>>) =>
  setPresenceReclaimPolicy({
    enabled: s.reclaimIdleCli,
    graceMs: s.presenceGraceMinutes * 60_000,
    unreadGraceMs: s.unreadGraceMinutes * 60_000,
  })
app.get('/settings', async (c) => c.json(await getSettings()))
// 本机能用的命令行环境（设置「常规」里选）；fresh=1 重新检测
void currentShell().catch(() => {})
app.get('/shells', async (c) => c.json(await detectShells(c.req.query('fresh') === '1')))
app.put('/settings', async (c) => {
  const p = Settings.safeParse(await c.req.json())
  if (!p.success) return bad(c, z.prettifyError(p.error))
  for (const id of Object.keys(p.data.clis)) if (!getCli(id)) delete p.data.clis[id]
  // 打开访问令牌的是这个浏览器：先给它发 Cookie，免得刚打开就把自己关在外面
  if (p.data.requireToken) grantCookie(c)
  const prev = await getSettings()
  const before = JSON.stringify(prev.remoteAccess)
  const saved = await saveSettings(p.data)
  // 对话页切走后 CLI 还等多久、没人看的会话留几个：保存后立即生效，不用重启服务
  applyPresenceReclaim(saved)
  // 命令行环境：工具说明里写的「命令在哪执行」跟着换
  void currentShell().catch(() => {})
  // API / 账号方式或 API 配置变了：立即写进 CLI 自己的配置，不用等到下一次执行
  await syncCliAuths(prev, saved)
  // 只有外网访问的开关、方式、地址变了才重启隧道；其他设置每次自动保存都把 quick 地址换掉会断线
  if (JSON.stringify(saved.remoteAccess) !== before) void applyRemote()
  return c.json(saved)
})

// 用户在数据目录里加的 CLI 配置：页面拿去注册；改了配置文件后可以重新读
app.get('/clis/specs', (c) => c.json(userClis()))
app.post('/clis/specs/reveal', async (c) => {
  await mkdir(CLI_CONFIG_DIR, { recursive: true })
  try {
    await revealDir(CLI_CONFIG_DIR)
  } catch (e) {
    return bad(c, (e as Error).message)
  }
  return c.json({ ok: true, dir: CLI_CONFIG_DIR })
})
app.post('/clis/specs/reload', async (c) => {
  loadUserClis()
  await detectClis(true)
  return c.json(userClis())
})
app.get('/clis', async (c) => c.json(await detectClis(c.req.query('refresh') === '1')))
app.route('/accounts', accountsApi())
app.route('/integrations', integrationsApi())
app.route('/library', libraryApi())
app.route('/mcp-tools', mcpApi())
// 项目设置里的 MCP：项目目录里识别到的配置，项目目录按 projectId 现取
app.route('/project-mcp', projectMcpApi({ projectPath: async (id) => (await projects.get(id))?.path ?? '' }))
app.route('/clis', installApi())
app.route('/local-image', comfyApi())
app.route('/clis', modelsApi())
app.route('/clis', packagesApi())
app.route('/model-catalog', modelCatalogApi())
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
    const list = await listSkills(c.req.param('id'), dir)
    // 设置里的 CLI 页只看 CLI 自己的 Skill：~/.agents/skills 是各 CLI 共用的，不在这里列
    return c.json(c.req.query('own') === '1' ? list.filter((s) => !isSharedSkill(s)) : list)
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
  // 复制出来的内置角色是普通角色：本机已经有这个来源的就去掉来源，不然会被当成第二个内置角色、跟着内置定义被覆盖。
  // 「内置 Agent」里添加的（本机还没有）保留来源
  if (
    r.data &&
    isBuiltinAgent(r.data) &&
    (isCoreAgent(r.data) || (await agents.list()).some((a) => a.origin === r.data!.origin))
  )
    r.data.origin = ''
  return r.error ? bad(c, r.error) : c.json(await agents.create(r.data!), 201)
})

app.put('/agents/:id', async (c) => {
  const id = c.req.param('id')
  const r = await parseAgent(await c.req.json(), id)
  if (r.error) return bad(c, r.error)
  // 内置角色（含必备角色）只能改参数取值和运行配置，其余按内置定义写回（AI 优化、导入改了也一样纠正）；
  // 其他内置角色还能改分类、标签和启用开关，必备角色的分类固定
  const before = await agents.get(id)
  const key = builtinKey(before ?? undefined)
  const def = key ? builtinDefinition(key) : undefined
  if (before && def)
    r.data = {
      ...syncCore(r.data!, def, {
        categoryId: isCoreAgent(before) ? before.categoryId : r.data!.categoryId,
        includes: before.includes,
      }),
      name: before.name,
      origin: before.origin,
      // 一次性升级记录只由启动同步维护，编辑页保存不带它也不能清掉，否则下次启动会把用户关掉的开关又改回去
      upgrades: before.upgrades,
    }
  const a = await agents.update(id, r.data!)
  return a ? c.json(a) : bad(c, t('角色不存在'), 404)
})

app.delete('/agents/:id', async (c) => {
  const id = c.req.param('id')
  if (isCoreAgent((await agents.get(id)) ?? undefined)) return bad(c, t('必备角色不能删除'), 409)
  const err = agentDeleteError(id, await workflows.list())
  if (err) return bad(c, err, 409)
  if (!(await agents.remove(id))) return bad(c, t('角色不存在'), 404)
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
/** 带 builtin 标记返回：新建的自建分类也明确给 false，和 GET 里的字段一致 */
const withBuiltinFlag = (x: ProjectCategory) => ({ ...x, builtin: isBuiltinProjectCategory(x.id) })
async function parseProjectCategory(body: unknown, selfId?: string) {
  const p = ProjectCategoryInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if ((await projectCategories.list()).some((x) => x.name === p.data.name && x.id !== selfId))
    return { error: t('分类「{name}」已存在', { name: p.data.name }) }
  if (p.data.workflowId && !(await workflows.get(p.data.workflowId))) return { error: t('工作流不存在') }
  return { data: p.data }
}

app.get('/project-categories', async (c) =>
  // builtin 标记以固定 id 为准：旧数据或手改的文件里缺这个字段时也返回正确的值，和删除判定一致
  c.json((await projectCategories.list()).map(withBuiltinFlag)),
)

app.post('/project-categories', async (c) => {
  const r = await parseProjectCategory(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(withBuiltinFlag(await projectCategories.create(r.data!)), 201)
})

app.put('/project-categories/:id', async (c) => {
  const id = c.req.param('id')
  const r = await parseProjectCategory(await c.req.json(), id)
  if (r.error) return bad(c, r.error)
  const x = await projectCategories.update(id, r.data!)
  return x ? c.json(withBuiltinFlag(x)) : bad(c, t('分类不存在'), 404)
})

// 删除分类时，其中的项目变为未分类
app.delete('/project-categories/:id', async (c) => {
  const id = c.req.param('id')
  const err = projectCategoryDeleteError(id)
  if (err) return bad(c, err, 409)
  if (!(await projectCategories.remove(id))) return bad(c, t('分类不存在'), 404)
  for (const p of await projects.list()) {
    if (p.categoryId === id) await projects.update(p.id, { ...p, categoryId: '' })
  }
  return c.body(null, 204)
})

// ---- 项目 ----
/**
 * 项目要有子对话默认工作流：子对话接到任务时先用它，可选工作流里更合适的优先。
 * 界面新建时默认带上「通用项目」；没有单独指定时跟随项目分类
 */
async function parseProject(body: unknown) {
  const p = ProjectInput.safeParse(body)
  if (!p.success) return { error: z.prettifyError(p.error) }
  if (p.data.categoryId && !(await projectCategories.get(p.data.categoryId))) return { error: t('项目分类不存在') }
  if (p.data.defaultAgentId && !(await agents.get(p.data.defaultAgentId))) return { error: t('默认对话角色不存在') }
  if (p.data.workflowId && !(await workflows.get(p.data.workflowId))) return { error: t('工作流不存在') }
  const cat = p.data.categoryId ? await projectCategories.get(p.data.categoryId) : null
  if (!p.data.workflowId && !cat?.workflowId) return { error: t('请为项目选择子对话默认工作流') }
  const effective = p.data.workflowId || cat?.workflowId || ''
  const optional = [...new Set(p.data.workflowIds)].filter((id) => id && id !== effective)
  for (const id of optional) if (!(await workflows.get(id))) return { error: t('可选工作流不存在') }
  p.data.workflowIds = optional
  // 跟随分类时配置也存在分类那个工作流名下，不能当成未知工作流丢掉
  const known = new Set([effective, ...optional])
  p.data.workflowParams = Object.fromEntries(Object.entries(p.data.workflowParams).filter(([id]) => known.has(id)))
  // 请求里带了默认 Agent 字段就说明用户设置过：以后不再用升级迁移覆盖
  if (body && typeof body === 'object' && 'defaultAgentId' in body) p.data.agentSet = true
  if (p.data.initResult !== undefined) {
    const saved = ProjectProposalSchema.safeParse(p.data.initResult)
    if (!saved.success) return { error: z.prettifyError(saved.error) }
    p.data.initResult = saved.data
  }
  if (p.data.path) p.data.path = resolvePath(p.data.path)
  return { data: p.data }
}

app.get('/projects', async (c) => c.json(sortProjects(await projects.list())))

// 新建项目时的 AI 分析：只读扫描本地目录，给出填好一半的表单
app.post('/projects/analyze', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: string }
  const p = typeof body.path === 'string' ? body.path.trim() : ''
  if (!p) return bad(c, t('请先选择本地目录'))
  const r = await analyzeProject(p)
  return 'error' in r ? bad(c, r.error) : c.json(r)
})

app.post('/projects', async (c) => {
  const r = await parseProject(await c.req.json())
  return r.error ? bad(c, r.error) : c.json(await projects.create(r.data!), 201)
})

/**
 * 侧栏拖拽后的顺序：body 是全部项目的 id，按新顺序排列。
 * 先整体校验再一次写盘，重复、不存在的 id 和漏掉的项目都直接拒绝，不会只改一半。
 */
app.put('/projects/order', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown
  if (!Array.isArray(body) || !body.every((id) => typeof id === 'string' && id.trim()))
    return bad(c, t('项目顺序格式不对'))
  const list = await projects.list()
  const ids = body as string[]
  const error = projectOrderError(list, ids)
  if (error) return bad(c, error)
  const ordered = orderProjects(list, ids)
  await projects.setAll(ordered)
  return c.json(sortProjects(ordered))
})

app.put('/projects/:id', async (c) => {
  const body = await c.req.json()
  const r = await parseProject(body)
  if (r.error) return bad(c, r.error)
  // 没带教训的请求（旧版界面、脚本）不清空已有的教训：它们大多是角色在对话里记的
  if (body && typeof body === 'object' && !('lessons' in body))
    r.data!.lessons = (await projects.get(c.req.param('id')))?.lessons ?? []
  // 初始化标记同理：只有项目设置页会带上它，脚本改设置不会把它清掉
  if (body && typeof body === 'object' && !('initializedAt' in body))
    r.data!.initializedAt = (await projects.get(c.req.param('id')))?.initializedAt ?? ''
  // 保存的推荐也是：没带的请求保留上次初始化的结果
  if (body && typeof body === 'object' && !('initResult' in body))
    r.data!.initResult = (await projects.get(c.req.param('id')))?.initResult
  const x = await projects.update(c.req.param('id'), r.data!)
  return x ? c.json(x) : bad(c, t('项目不存在'), 404)
})

// 记一条项目教训（对话里「记成项目教训」）：单独的接口，不用把整个项目设置发回来，也不会盖掉 Agent 刚记的
const lessons = projectLessons(projects)
app.post('/projects/:id/lessons', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.title !== 'string') return bad(c, t('规则不能为空'))
  const r = await lessons.record(c.req.param('id'), {
    ...(body as Partial<LessonDraft>),
    title: body.title,
    source: 'user',
  })
  return r.ok && r.project ? c.json(r.project) : bad(c, r.info)
})

// AI 评审项目教训：用户在评审卡片上逐条点「应用」，一次一条
app.post('/projects/:id/lessons/review', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { item?: unknown } | null
  const review = parseLessonReview(
    '```' + LESSON_REVIEW_LANG + '\n' + JSON.stringify({ items: [body?.item] }) + '\n```',
  )
  const item = review?.items[0]
  if (!item) return bad(c, t('评审建议的格式不对'))
  const r = await lessons.review(c.req.param('id'), item)
  return r.ok && r.project ? c.json(r.project) : bad(c, r.info)
})

// 全局教训：所有项目共用。只有界面上用户确认过的修改才会写进来，Agent 没有写它的工具
app.get('/global-lessons', async (c) => c.json(await readGlobalLessons()))
app.put('/global-lessons', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { lessons?: unknown; confirmed?: unknown } | null
  if (body?.confirmed !== true) return bad(c, t('修改全局教训需要你确认'))
  const r = GlobalLessons.safeParse(body.lessons)
  if (!r.success) return bad(c, r.error.issues.map((i) => i.message).join('；'))
  return c.json(await writeGlobalLessons(r.data))
})

// 项目是不是 agent-panel 自己的源代码：AI 分析结果据此决定能不能开子对话改进源代码
app.get('/projects/:id/panel-source', async (c) => {
  const p = await projects.get(c.req.param('id'))
  return p ? c.json({ panelSource: await isPanelSource(p.path) }) : bad(c, t('项目不存在'), 404)
})

app.delete('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const repo = (await projects.get(id))?.path
  if (!(await projects.remove(id))) return bad(c, t('项目不存在'), 404)
  await tasks.removeByProject(id, repo)
  return c.body(null, 204)
})

// ---- 任务 ----
const tasks = tasksApi({ agents, workflows, projects, projectCategories, recordLesson: lessons.record })

/**
 * 回收没人管的独立工作目录：面板重启、父对话结束、任务记录丢了之后，不再有人触发收口，
 * 已合并的目录会一直留在磁盘上（见 server/exec/worktree.ts 的 sweepWorktrees）。
 * 只清「改动都已合回原分支 + 任务已收口 / 记录已不存在」的，以及 git 注册表外的残留；
 * 在改、没合、还在跑的一律不碰。出问题时可以用 AGENT_PANEL_KEEP_WORKTREES=1 启动，只扫不删。
 */
async function sweepStaleWorktrees() {
  if (process.env.AGENT_PANEL_KEEP_WORKTREES === '1') return
  // 正在执行的任务从内存里拿：任务记录里的 working 可能是上一轮留下的
  const working = new Set(tasks.workingTasks().map((w) => w.id))
  const res = await sweepWorktrees({
    taskInfo: async (id) => {
      const tk = await tasks.get(id)
      if (!tk) return null
      const p = tk.projectId ? await projects.get(tk.projectId) : null
      return {
        // 显式收口，或者这一轮已经跑完 / 被停掉：剩下没人会再触发收口（面板重启、父对话结束）
        done: tk.resolved === true || tk.archived === true || tk.status === 'done' || tk.status === 'stopped',
        // 等下一句、预热中的 CLI 还活着，也算在用，目录不能动
        working: working.has(id) || tk.working === true || tk.awaitingUser === true || tk.prewarming === true,
        projectPath: p?.path ?? '',
        branch: tk.worktree?.branch ?? '',
        baseBranch: tk.worktree?.baseBranch ?? '',
      }
    },
  }).catch((e: Error) => {
    log.error('worktree', '清扫独立目录出错', { error: e.message })
    return null
  })
  if (res)
    log.info('worktree', '清扫独立目录完成', {
      dryRun: res.dryRun,
      removed: res.removed.length,
      kept: res.kept.length,
      failed: res.failed.length,
    })
}

app.route('/tasks', tasks.routes)
// 整个运行的用量（父对话 + 所有子对话 + 派出的子任务）：子对话不在任务列表里，只能服务端算
app.route('/tasks', runUsageApi({ tasks }).routes)
// 会话内存的 AI 分析：采样序列 + 进程面板两路 + 任务树规模，整理成交给本机 CLI 的报告
app.route(
  '/tasks',
  taskMemoryApi({
    tasks,
    panel: (id) => tasks.processPanel(id),
    projects,
  }).routes,
)
// 设置页的用量统计：按天 / 周 / 月聚合各任务每轮执行的 token
app.route('/usage', usageApi({ tasks }).routes)
app.route('/assist', assistApi({ agents, categories, workflows, projects }))
// ---- UI 设计和连接浏览器的扩展 ----
const designs = designsApi({ projects })
app.post('/designs/browser/reveal', async (c) => {
  const dir = extensionDir()
  if (!dir) return bad(c, t('没有找到扩展目录'))
  try {
    await revealDir(dir)
  } catch (e) {
    return bad(c, (e as Error).message)
  }
  return c.json({ ok: true, dir })
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
    await revealItem(dir)
  } catch (e) {
    return bad(c, (e as Error).message)
  }
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
app.route('/ai-fix', fixApi())
// 项目设置里的 Skill 分节：项目目录下的技能
app.route('/project-skills', projectSkillsApi({ projects }))
app.route('/deploy', deployApi({ startDoc: docs.start }))

// ---- 附件和 @ 引用的项目文件 ----
app.route('/uploads/raw', uploadsRawApi())
app.route('/uploads', uploadsApi({ dirs: async () => (await projects.list()).map((p) => p.path).filter(Boolean) }))
// 文件浏览页：项目里的文件树、内容搜索、看单个文件
app.route('/project-files', filesApi({ projects }))
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

// 本地分支：环境里点分支名展开的下拉用
app.get('/fs/branches', async (c) => {
  try {
    return c.json(await gitBranches(resolvePath(c.req.query('path') ?? '')))
  } catch (e) {
    return bad(c, (e as Error).message)
  }
})

// 切换到另一个本地分支；有未提交的改动挡住时把 git 的说明带回去
app.post('/fs/checkout', async (c) => {
  const { path: p, branch } = (await c.req.json().catch(() => ({}))) as { path?: string; branch?: string }
  const dir = resolvePath(String(p ?? ''))
  try {
    await gitCheckout(dir, String(branch ?? ''))
    return c.json(await inspectDir(dir))
  } catch (e) {
    return bad(c, t('切换分支失败：{error}', { error: (e as Error).message }))
  }
})

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
  try {
    await revealDir(dir)
  } catch (e) {
    return bad(c, (e as Error).message)
  }
  return c.json({ ok: true, dir })
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

// 内存采样：面板自身的进程 + 它拉起的 CLI 子进程，定时记一次留在内存里，数据页的内存曲线和 AI 分析读它
const memory = memorySampler({
  running: () => tasks.running() + designs.running(),
  scale: async () => {
    const all = await tasks.list()
    return {
      tasks: all.length,
      chats: all.filter((x) => x.mode === 'chat').length,
      projects: (await projects.list()).length,
    }
  },
})
memory.start()

app.route('/data', dataApi({ running: () => tasks.running() + designs.running(), memory }))

const updater = updateApi({
  running: () => tasks.running() + designs.running(),
  // server 在下面才创建，重启时一定已经有了
  restart: () => (process.env.AGENT_PANEL_NO_RESTART ? undefined : restartProcess(() => server.close())),
  // 强制更新：先让任务里的 CLI 收尾；设计、文档、模型补全这些不在任务里的也一起结束
  stopAll: async () => {
    await tasks.stopAll()
    killAllProcesses()
  },
  interrupted: () => tasks.workingTasks(),
})
app.route('/app', updater.api)
app.route('/app', pageEventsApi())
// 操控软件的动作表（见 ADR 0011）：Agent 经 MCP 调，人和脚本经 /api/actions 调；
// 动作进程内调上面这些接口，和界面点按钮走同一段代码
app.route('/actions', appActionsApi())
setActionHost({
  api: (method, path, body) => callApi((req) => app.fetch(req), method, path, body),
  ui: (action, args) => signalPages({ type: 'ui', action, args }),
})
// 新版本启动后问用户要不要继续被上次强制更新打断的任务
app.route(
  '/app',
  interruptedApi({
    ready: () => tasks.ready(),
    getTask: (id) => tasks.get(id),
    projectName: async (id) => (await projects.get(id))?.name ?? '',
  }),
)
app.route('/remote', remoteApi({ link: withToken }))

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
// 只监听本机：这个服务之后会启动本地 CLI，不应暴露到局域网。
// 要从外网访问时，由 cloudflared（或用户自己的反向代理）把请求转到 127.0.0.1，见 remote.ts
configureRemote(port)
const server = serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, async () => {
  // 把实际端口打出来（一行给工具解析）：PORT=0 时端口由系统分配，端到端测试照着它连，
  // 不用「先探测空闲端口再传给服务」——探测（listen 后立刻 close）和真正监听之间有窗口，
  // 并行的分片会拿到同一个端口（见 scripts/e2e/spawn-server.mjs）
  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  console.log(`AGENT_PANEL_PORT ${actualPort}`)
  // 其它模块按 PORT 环境变量拼面板地址（ask-mcp、design-mcp、remote）：模块加载时读到的是 0，
  // 这里把实际端口写回去，否则交给 CLI 的面板 MCP 地址是 127.0.0.1:0，CLI 连不上就直接退出了
  process.env.PORT = String(actualPort)
  configureRemote(actualPort)
  // 地址带上访问令牌：设置里打开令牌后，只有从这里打开的浏览器能访问
  const url = withToken(`http://127.0.0.1:${actualPort}`)
  console.log(`Agent 面板服务已启动: ${url}`)
  log.info('server', '启动', { version: currentVersion(), data: DATA_DIR, log: logFile(), prod, tray, restarted })
  // 作为系统服务登录时自动启动的，不打开浏览器，免得每次开机都弹出来
  // 设置里开着外网访问时启动隧道；quick 模式的地址要等 cloudflared 输出，设置页里能看到
  // 内存曲线：30 秒采一点（面板 server + 各对话的 CLI 进程树），落盘后重启接着用
  stopMemorySampler = startMemorySampler()
  // 回收没人管的独立目录：启动后跑一次，之后每小时一次（进程退出不用等它）
  setTimeout(() => void sweepStaleWorktrees(), 10_000).unref()
  setInterval(() => void sweepStaleWorktrees(), 60 * 60_000).unref()
  // 上次关掉、崩溃时没来得及删的面板 MCP 条目（项目 .mcp.json 里的 agent-panel、panel-xxxx）：启动时清一遍
  void sweepProjectsPanelMcp()
  void applyRemote()
  void getSettings().then(applyPresenceReclaim)
  const open = prod && !restarted && !process.env.AGENT_PANEL_SUPERVISED && (await getSettings()).openBrowser
  if (tray) {
    // 托盘程序读这两行：显示地址，并由它打开浏览器（服务自己打开会经过 cmd）
    console.log(`AGENT_PANEL_READY ${url}`)
    if (open) console.log(`AGENT_PANEL_OPEN ${url}`)
  } else if (open) openBrowser(url)
})
/** 停掉内存采样的定时器，并把这批点写进历史 */
let stopMemorySampler: (() => void) | undefined

/**
 * 退出前停掉正在执行的 CLI，并把任务状态落盘。macOS / Linux 上 CLI 跑在独立的进程组里，
 * 服务退出时不会跟着结束，不停掉的话会在后台继续改项目。最多等 5 秒。
 */
let exiting = false
async function shutdown(code = 0) {
  if (exiting) return process.exit(1)
  exiting = true
  log.info('server', '正在退出，停止正在执行的任务')
  stopMemorySampler?.()
  server.close()
  await Promise.race([stopRemote(), new Promise((r) => setTimeout(r, 5000))])
  await Promise.race([tasks.stopAll(), new Promise((r) => setTimeout(r, 5000))])
  // 不在任务里的 CLI（AI 创建、设计、文档、模型补全、检测命令）也要一起结束
  killAllProcesses()
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown())
if (tray) {
  cleanupOldTray()
  // 托盘程序退出时会关掉服务的输入：停掉 CLI、收尾后退出
  process.stdin.on('end', () => void shutdown())
  // 托盘菜单的操作按行写进来，结果按约定的行输出给托盘（见 scripts/tray/AgentPanel.cs）
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    const c = parseTrayCommand(line)
    if (c?.cmd === 'focus')
      console.log(`AGENT_PANEL_FOCUS ${c.mark} ${signalPages({ type: 'focus', mark: c.mark, view: c.view })}`)
    else if (c?.cmd === 'update')
      void updater.checkAndInstall((state, text) =>
        console.log(`AGENT_PANEL_UPDATE ${state} ${text.replace(/\s*\n\s*/g, ' ')}`),
      )
  })
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
