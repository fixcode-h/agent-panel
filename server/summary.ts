/**
 * 工作总结：按天 / 按周提炼分项，用户采纳后拼成报告。
 *
 * - POST /summary/extract：开始一次提炼（job），页面轮询 /summary/jobs/:id 拿分项；
 *   来源是「对话」时取面板里加过的项目在窗口内执行过的对话，来源是「报告」时取窗口内已经生成的报告；
 *   用「每日工作总结」角色的设定和它的 CLI / 模型跑，CLI 只读运行、不改文件。
 * - POST /summary：用采纳的分项按固定格式拼出报告并保存（不再跑 CLI）。
 * - PUT / DELETE /summary/:id：编辑正文、删除报告；GET / PUT /summary/config：面板里加过的项目。
 * 口径（时间窗口、材料、提示词、解析、拼报告）都在 shared/summary.ts。
 */
import { askSession } from './asks.ts'
import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getCli } from '../shared/clis.ts'
import type { Agent, Project, Task } from '../shared/schema.ts'
import { taskDeleted } from '../shared/task.ts'
import { renderTemplate, resolveParams } from '../shared/agent-role.ts'
import {
  activeInRange,
  collectRangeProjects,
  extractPrompt,
  extractRetryHint,
  parseExtract,
  renderReport,
  reportsContext,
  reportsInWindow,
  skippedProjects,
  SUMMARY_KEEP,
  summaryRole,
  SummaryConfig,
  SummaryCreateRequest,
  SummaryExtractRequest,
  SummaryRecord,
  SummaryReport,
  summaryPeriod,
  tasksContext,
  type SummaryJob,
} from '../shared/summary.ts'
import { agentPermission, agentRun, cliSettings } from '../shared/settings.ts'
import { safeArgs } from './assist.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { t } from '../shared/i18n.ts'

const TIMEOUT = 10 * 60_000

/** 数据目录里的报告集合（在 server/index.ts 建好传进来，和别的数据共用一套读写） */
type Reports = {
  list(): Promise<SummaryRecord[]>
  create(input: z.infer<typeof SummaryReport>): Promise<SummaryRecord>
  update(id: string, input: z.infer<typeof SummaryReport>): Promise<SummaryRecord | null>
  remove(id: string): Promise<boolean>
}

type Job = SummaryJob & { abort: AbortController; at: number }

/**
 * 角色设定里只取它自己的那段（套上「材料：面板提供」）：引入的「通用约束」讲的是改代码、派子任务、等后台，
 * 和提炼分项无关，放进去只会多花 token
 */
export function summaryRoleText(role: Pick<Agent, 'instructions' | 'params'>) {
  const { values } = resolveParams(role.params, { material: '面板提供' })
  return renderTemplate(role.instructions, values).trim()
}

export function summaryApi(deps: {
  /** 列表只带用户消息（摘要用）：要 Agent 的回复得按 id 再取完整任务，见下面的 run() */
  tasks: { list(): Promise<Task[]>; get(id: string): Promise<Task | null> }
  projects: { list(): Promise<Project[]> }
  agents: { list(): Promise<Agent[]> }
  reports: Reports
  config: { get(): Promise<SummaryConfig>; set(c: SummaryConfig): Promise<void> }
}) {
  const jobs = new Map<string, Job>()
  const view = ({ abort, at, ...j }: Job): SummaryJob => j
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  // 跑完的 job 留一小时：页面刷新后还能拿回分项，不用一直占内存
  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 600_000).unref()

  const sorted = async () => (await deps.reports.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  /** 这次提炼的材料：对话按项目整理，报告取窗口内的；顺带记下用了多少、哪些项目没有内容 */
  async function material(job: Job, input: SummaryExtractRequest, projects: Project[]) {
    const win = summaryPeriod(input.grain, input.day)
    if (input.source === 'reports') {
      const list = reportsInWindow(await deps.reports.list(), win)
      job.reportCount = list.length
      const names = [...new Set(list.flatMap((r) => r.projectNames))]
      return { win, names, context: list.length ? reportsContext(list) : '' }
    }
    // 按面板里加的顺序找项目：这个顺序就是报告里分节的顺序，找不到的（已删）直接丢掉
    const chosen = input.projectIds
      .map((id) => projects.find((x) => x.id === id))
      .filter((p): p is Project => !!p)
      .map((p) => ({ id: p.id, name: p.name }))
    const ids = new Set(chosen.map((p) => p.id))
    // 列表里的任务只带用户消息，Agent 的结论不在里面：先按时间字段筛出窗口内有活动的，再按 id 读完整对话。
    // 删进回收站的对话不算：用户已经把它删了，报告里不该再出现
    const candidates = (await deps.tasks.list()).filter(
      (x) => ids.has(x.projectId) && activeInRange(x, win) && !taskDeleted(x),
    )
    const full = (await Promise.all(candidates.map((x) => deps.tasks.get(x.id)))).filter((x): x is Task => !!x)
    const dayProjects = collectRangeProjects(full, chosen, win)
    const skipped = skippedProjects(chosen, dayProjects)
    if (skipped.length) job.skipped = skipped
    job.taskCount = dayProjects.reduce((n, p) => n + p.tasks.length, 0)
    return {
      win,
      names: dayProjects.map((p) => p.projectName),
      context: job.taskCount ? tasksContext(dayProjects) : '',
    }
  }

  async function run(job: Job, input: SummaryExtractRequest) {
    const failed = (error: string) => {
      job.status = 'failed'
      job.error = error
      log.warn('summary', '提炼工作总结失败', error)
    }
    const settings = await getSettings()
    const role = summaryRole(await deps.agents.list())
    const r0 = agentRun(role, settings)
    const def = getCli(r0.cli)
    if (!def) return failed(t('未知的 Agent：{cli}', { cli: r0.cli }))
    const cs = cliSettings(settings, r0.cli)
    Object.assign(job, { cli: r0.cli, model: r0.model, effort: r0.effort })
    const projects = await deps.projects.list()
    const { win, names, context } = await material(job, input, projects)
    // 没有材料就不跑 CLI：空着交给页面说明「这段时间没有可提炼的内容」，不让 CLI 对着空材料编
    if (!context) {
      job.items = []
      job.status = 'done'
      return
    }
    // 材料已经在提示词里，CLI 不需要读代码：放在第一个有目录的项目里跑（只读权限），各 CLI 启动时读项目说明也不会出错
    const dir = projects.find((p) => input.projectIds.includes(p.id) && p.path)?.path || process.cwd()
    log.info('summary', `用 ${def.name} 提炼工作总结`, {
      source: input.source,
      grain: input.grain,
      from: win.fromDay,
      to: win.toDay,
      tasks: job.taskCount,
      reports: job.reportCount,
    })

    let text = ''
    let errors: string[] = []
    let result: { ok: boolean; error?: string } | undefined
    const asks = askSession(`summary:${job.id}`, () => job.abort.abort())
    const generate = (prompt: string) => {
      text = ''
      errors = []
      result = undefined
      // 重试是另一次生成：上一次的思考、工具标签和字数不能混进来
      job.thinking = undefined
      job.tools = []
      job.outChars = 0
      return invokeCli({
        askUser: asks.askUser,
        onAsk: asks.onAsk,
        cliId: r0.cli,
        command: cs.command,
        build: {
          model: r0.model,
          effort: r0.effort,
          permission: def.readOnly || agentPermission(role, settings),
          extraArgs: safeArgs(cs.extraArgs),
        },
        cwd: dir,
        env: childEnv(cs.env),
        input: prompt,
        signal: job.abort.signal,
        timeoutMs: TIMEOUT,
        onEvent: (ev) => {
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
          else if (ev.type === 'error') errors.push(ev.message)
          else if (ev.type === 'thinking')
            job.thinking = (ev.delta ? (job.thinking ?? '') + ev.text : ev.text).slice(-1500)
          else if (ev.type === 'tool') job.tools = [...job.tools, ev.tool.label].slice(-5)
          else if (ev.type === 'result') result = ev
          job.outChars = text.length
        },
      })
    }
    /** 一次生成失败的原因；成了就返回空串。'stopped' 不是错误，页面按普通提示显示 */
    const failure = (r: Awaited<ReturnType<typeof invokeCli>>) => {
      if (r.killed === 'stopped') return 'stopped'
      if (r.killed === 'timeout') return t('超过 {n} 分钟没有完成，已停止', { n: TIMEOUT / 60_000 })
      if (r.spawnError)
        return t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
          error: r.spawnError,
          cli: def.name,
          hint: def.installHint,
        })
      if (result ? !result.ok : r.code !== 0)
        return t('{cli} 执行失败：{detail}', {
          cli: def.name,
          detail:
            [result?.error, ...errors, r.stderr.trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n') ||
            t('没有更多信息'),
        })
      return ''
    }

    try {
      const prompt = extractPrompt({ role: summaryRoleText(role), win, source: input.source, projects: names, context })
      let why = failure(await generate(prompt))
      if (why === 'stopped') return void (job.status = 'stopped')
      if (why) return failed(why)
      let parsed = parseExtract(text, names, randomUUID)
      // 回答解析不了时带上原因再跑一次（只重试一次，日志里记下）；仍然不行就把原因交给页面，不当成「没有内容」
      if (parsed.error) {
        log.warn('summary', '工作总结的分项解析不了，重试一次', parsed.error)
        why = failure(await generate(prompt + extractRetryHint(parsed.error)))
        if (why === 'stopped') return void (job.status = 'stopped')
        if (why) return failed(why)
        parsed = parseExtract(text, names, randomUUID)
        if (parsed.error)
          return failed(t('{cli} 的回答解析不了（已重试一次）：{error}', { cli: def.name, error: parsed.error }))
      }
      job.items = parsed.items
      job.durationMs = Date.now() - job.startedAt
      job.status = 'done'
    } finally {
      asks.done()
    }
  }

  /** 开始一次提炼：先检查角色用的 CLI 能用，跑起来后用 /jobs/:id 查 */
  async function start(c: Context, input: SummaryExtractRequest) {
    if (input.source === 'tasks' && !input.projectIds.length) return bad(c, t('先添加要总结的项目'))
    const settings = await getSettings()
    const r0 = agentRun(summaryRole(await deps.agents.list()), settings)
    if (!getCli(r0.cli)) return bad(c, t('未知的 Agent：{cli}', { cli: r0.cli }))
    if (!cliSettings(settings, r0.cli).enabled)
      return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(r0.cli)!.name }))
    const win = summaryPeriod(input.grain, input.day)
    const job: Job = {
      id: randomUUID(),
      status: 'running',
      source: input.source,
      grain: input.grain,
      from: win.fromDay,
      to: win.toDay,
      projectIds: input.projectIds,
      items: [],
      taskCount: 0,
      reportCount: 0,
      cli: r0.cli,
      model: r0.model,
      effort: r0.effort,
      tools: [],
      outChars: 0,
      startedAt: Date.now(),
      abort: new AbortController(),
      at: Date.now(),
    }
    jobs.set(job.id, job)
    run(job, input)
      .catch((e) => {
        job.status = 'failed'
        job.error = (e as Error).message
      })
      .finally(() => (job.at = Date.now()))
    return c.json(view(job), 201)
  }

  /** 存一份报告；超过 SUMMARY_KEEP 时删最早的，删失败只记日志，不影响「已保存」的结论 */
  async function save(body: z.infer<typeof SummaryReport>) {
    const record = await deps.reports.create(body)
    try {
      for (const old of (await sorted()).slice(SUMMARY_KEEP)) await deps.reports.remove(old.id)
    } catch (e) {
      log.warn('summary', '清理旧的工作总结报告失败', (e as Error).message)
    }
    log.info('summary', '存了一份工作总结报告', {
      id: record.id,
      from: body.from,
      to: body.to,
      items: body.items.length,
    })
    return record
  }

  const routes = new Hono()
    .get('/', async (c) => c.json({ reports: await sorted() }))
    .get('/config', async (c) => c.json(await deps.config.get()))
    .put('/config', async (c) => {
      const p = SummaryConfig.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const ids = [...new Set(p.data.projectIds)]
      await deps.config.set({ projectIds: ids })
      return c.json({ projectIds: ids })
    })
    .post('/extract', async (c) => {
      const p = SummaryExtractRequest.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      return start(c, p.data)
    })
    .get('/jobs/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : bad(c, t('找不到这次提炼，可能已过期'), 404)
    })
    .post('/jobs/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return bad(c, t('找不到这次提炼'), 404)
      j.abort.abort()
      return c.json(view(j))
    })
    .post('/', async (c) => {
      const p = SummaryCreateRequest.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const { items, ...meta } = p.data
      const record = await save({
        ...meta,
        day: meta.to,
        md: renderReport({ grain: meta.grain, from: meta.from, to: meta.to, items }),
        items,
      })
      return c.json(record, 201)
    })
    .put('/:id', async (c) => {
      const p = z.object({ md: z.string().max(200_000) }).safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const old = (await deps.reports.list()).find((r) => r.id === c.req.param('id'))
      if (!old) return bad(c, t('找不到这份报告'), 404)
      const next = await deps.reports.update(old.id, { ...old, md: p.data.md })
      return next ? c.json(next) : bad(c, t('找不到这份报告'), 404)
    })
    .delete('/:id', async (c) => {
      const ok = await deps.reports.remove(c.req.param('id'))
      return ok ? c.json({ ok: true }) : bad(c, t('找不到这份报告'), 404)
    })
  return { routes }
}
