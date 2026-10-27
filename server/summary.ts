/**
 * 工作总结：把选中的项目里「今天」执行过的对话交给本机 CLI，生成一份简短的 Markdown 报告。
 *
 * 只取任务记录里今天的数据（见 shared/summary.ts），CLI 在项目目录里只读运行、不改文件；
 * 生成结果是 job，页面轮询 /summary/jobs/:id；成功时存一份报告（可再编辑），保留最近 SUMMARY_KEEP 份。
 */
import { askSession } from './asks.ts'
import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getCli } from '../shared/clis.ts'
import type { Project, Task } from '../shared/schema.ts'
import { taskDeleted } from '../shared/task.ts'
import {
  activeInRange,
  checkSummaryFormat,
  collectRangeProjects,
  extractSummary,
  rangeWindow,
  SUMMARY_KEEP,
  SummaryRecord,
  SummaryRequest,
  SummaryReport,
  skippedProjects,
  summaryPrompt,
  summaryRetryHint,
  type SummaryJob,
} from '../shared/summary.ts'
import { agentRun, cliSettings } from '../shared/settings.ts'
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

/** 任务里今天有活动的时间字段：用它先筛出要读完整对话的任务，不用把每个任务都读一遍 */

export function summaryApi(deps: {
  /** 列表只带用户消息（摘要用）：要 Agent 的回复得按 id 再取完整任务，见下面的 run() */
  tasks: { list(): Promise<Task[]>; get(id: string): Promise<Task | null> }
  projects: { list(): Promise<Project[]> }
  reports: Reports
}) {
  const jobs = new Map<string, SummaryJob & { abort: AbortController; at: number }>()
  const view = ({ abort, at, ...j }: SummaryJob & { abort: AbortController; at: number }): SummaryJob => j
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  // 跑完的 job 留一小时：页面刷新后还能拿回结果，不用一直占内存
  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 600_000).unref()

  /** 生成成功后存一份；裁剪旧报告失败只记日志，不影响「已保存」的结论 */
  async function save(job: SummaryJob, body: Omit<z.infer<typeof SummaryReport>, 'md'> & { md: string }) {
    const record = await deps.reports.create(body)
    job.reportId = record.id
    try {
      const all = (await deps.reports.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      for (const old of all.slice(SUMMARY_KEEP)) await deps.reports.remove(old.id)
    } catch (e) {
      // 报告已经写进去了，清理超量的旧报告失败不能让页面以为没保存上
      log.warn('summary', '清理旧的工作总结报告失败', (e as Error).message)
    }
    log.info('summary', `存了一份工作总结报告`, { id: record.id, day: body.day, projects: body.projectIds.length })
    return record
  }

  async function run(job: SummaryJob & { abort: AbortController }, input: z.infer<typeof SummaryRequest>) {
    const failed = (error: string) => {
      job.status = 'failed'
      job.error = error
      log.warn('summary', '生成工作总结失败', error)
    }
    const settings = await getSettings()
    const def = getCli(input.cli)!
    const cs = cliSettings(settings, input.cli)
    const r0 = agentRun({ cli: input.cli, model: input.model, effort: input.effort }, settings)
    const all = await deps.projects.list()
    // 按用户加进来的顺序找项目：这个顺序就是报告里分节的顺序，找不到的直接丢掉
    const chosen = input.projects.map((p) => all.find((x) => x.id === p.projectId)).filter((p): p is Project => !!p)
    if (!chosen.length) return failed(t('项目不存在'))
    const now = new Date()
    // 时间窗口和页面、存档用同一个函数（shared/summary.ts 的 rangeWindow）：范围口径只有一处
    const win = rangeWindow(input.range, now)
    const day = win.toDay
    // 列表里的任务只带用户消息（server/task-store.ts 的 head），Agent 的结论不在里面。
    // 先按时间字段筛出范围内有活动的，再按 id 读完整对话；不这样报告里永远没有「做了什么、怎么修的」
    const ids = new Set(chosen.map((p) => p.id))
    // 时间范围只由 activeInRange 判（口径在 shared/summary.ts 的 rangeWindow）；
    // 删进回收站的对话不算这次总结的工作：用户已经把它删了，报告里不该再出现
    const candidates = (await deps.tasks.list()).filter(
      (t) => ids.has(t.projectId) && activeInRange(t, win) && !taskDeleted(t),
    )
    const full = await Promise.all(candidates.map((t) => deps.tasks.get(t.id)))
    // 每个项目只分析用户选的对话；taskIds 为空表示该项目范围内全部对话
    const picks = input.projects
      .filter((p) => ids.has(p.projectId))
      .map((p) => ({ id: p.projectId, name: chosen.find((x) => x.id === p.projectId)!.name, taskIds: p.taskIds }))
    const projects = collectRangeProjects(
      full.filter((t): t is Task => !!t),
      picks,
      input.range,
      now,
    )
    // 用户选了但今天没有可总结内容的项目（只改了状态/归档、没有今天的对话）：记下来给页面提示，不悄悄从报告里删掉
    const skipped = skippedProjects(picks, projects)
    if (skipped.length) job.skipped = skipped
    // 提示词里已经带着今天的记录，CLI 不需要再读代码：放在第一个有目录的项目里跑（只读权限），
    // 这样各 CLI 拿到的都是一个正常的项目工作目录，启动时读项目说明也不会出错
    const dir = chosen.find((p) => p.path)?.path || process.cwd()
    const taskCount = projects.reduce((n, p) => n + p.tasks.length, 0)
    log.info('summary', `用 ${def.name} 生成工作总结`, {
      day,
      from: win.fromDay,
      projects: chosen.length,
      tasks: taskCount,
      picks: picks.map((p) => p.taskIds.length),
    })

    let text = ''
    let errors: string[] = []
    let result: { ok: boolean; error?: string } | undefined
    /** 已经写出来的部分交给页面：失败 / 停止时至少能看、能复制，不用重新跑一遍 */
    const keepPartial = () => {
      const partial = extractSummary(text)
      if (partial.trim()) job.md = partial
    }
    const asks = askSession(`summary:${job.id}`, () => job.abort.abort())
    /** 跑一次 CLI：格式不合格重试时再跑一遍，提问卡片和资源都沿用同一个 job */
    const generate = (prompt: string) => {
      text = ''
      errors = []
      result = undefined
      // 重试是另一次生成：上一次的思考、工具标签和字数不能混进来（页面上看着像同一次在继续跑）
      job.thinking = undefined
      job.tools = []
      job.outChars = 0
      return invokeCli({
        askUser: asks.askUser,
        onAsk: asks.onAsk,
        cliId: input.cli,
        command: cs.command,
        build: {
          model: r0.model,
          effort: r0.effort,
          permission: def.readOnly || cs.permission,
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

    let md = ''
    try {
      const first = await generate(summaryPrompt({ day, projects, range: win }))
      const why = failure(first)
      if (why === 'stopped') {
        job.status = 'stopped'
        keepPartial()
        return
      }
      if (why) {
        keepPartial()
        return failed(why)
      }
      md = extractSummary(text)
      if (!md.trim()) return failed(t('{cli} 没有给出报告内容，可以再试一次', { cli: def.name }))
      // 生成后自己校一遍结构：不合格就带上具体问题再跑一次（只重试一次），
      // 仍然不合格也保存，但在 job 上标出来，页面上明确提示「格式不完整」，不静默通过
      let retried = false
      let check = checkSummaryFormat(md)
      if (!check.ok) {
        retried = true
        log.warn('summary', '工作总结格式不完整，重试一次', { issues: check.issues })
        const again = await generate(summaryPrompt({ day, projects, range: win }) + summaryRetryHint(check.issues))
        if (again.killed === 'stopped') {
          job.status = 'stopped'
          job.md = md
          return
        }
        // 重试失败或没写出东西时保留第一次的结果：总比空着强
        const next = failure(again) ? '' : extractSummary(text)
        if (next.trim()) md = next
        check = checkSummaryFormat(md)
        if (!check.ok) log.warn('summary', '工作总结重试后格式仍然不完整', { issues: check.issues })
      }
      job.format = { ok: check.ok, issues: check.issues, retried }
    } finally {
      asks.done()
    }
    // 先把正文交给页面：保存失败时用户至少能看到、能复制这份报告，不用重新跑一遍
    job.md = md
    try {
      await save(job, {
        day,
        from: win.fromDay,
        to: win.toDay,
        // 存实际写进报告的项目（被跳过的项目不进元数据，和正文保持一致）
        projectIds: projects.map((p) => p.projectId),
        projectNames: projects.map((p) => p.projectName),
        md,
        cli: input.cli,
        model: r0.model,
        effort: r0.effort,
        taskCount,
      })
    } catch (e) {
      return failed(t('报告没能保存：{error}', { error: (e as Error).message }))
    }
    job.status = 'done'
  }

  /** 开始一次生成：检查 CLI 能用，跑起来后用 /jobs/:id 查 */
  async function start(c: Context, input: z.infer<typeof SummaryRequest>) {
    if (!getCli(input.cli)) return bad(c, t('未知的 Agent：{cli}', { cli: input.cli }))
    if (!cliSettings(await getSettings(), input.cli).enabled)
      return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(input.cli)!.name }))
    const started = rangeWindow(input.range)
    const job: SummaryJob & { abort: AbortController; at: number } = {
      id: randomUUID(),
      status: 'running',
      projectIds: input.projects.map((p) => p.projectId),
      // 范围在开始时就定下来：生成过程中页面换了范围，这份结果仍然属于开始时那一段
      from: started.fromDay,
      to: started.toDay,
      md: '',
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

  const routes = new Hono()
    .get('/', async (c) => {
      const reports = (await deps.reports.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      return c.json({ reports })
    })
    .post('/', async (c) => {
      const p = SummaryRequest.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      return start(c, p.data)
    })
    .get('/jobs/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : bad(c, t('找不到这次生成，可能已过期'), 404)
    })
    .post('/jobs/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return bad(c, t('找不到这次生成'), 404)
      j.abort.abort()
      return c.json(view(j))
    })
    .put('/:id', async (c) => {
      const p = z.object({ md: z.string().max(200_000) }).safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const old = await deps.reports.list().then((all) => all.find((r) => r.id === c.req.param('id')))
      if (!old) return bad(c, t('找不到这份报告'), 404)
      const next = await deps.reports.update(c.req.param('id'), { ...old, md: p.data.md })
      return next ? c.json(next) : bad(c, t('找不到这份报告'), 404)
    })
  return { routes }
}
