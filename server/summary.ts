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
import {
  collectDayProjects,
  extractSummary,
  SUMMARY_KEEP,
  SummaryRecord,
  SummaryRequest,
  SummaryReport,
  summaryPrompt,
  todayWindow,
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

export function summaryApi(deps: {
  tasks: { list(): Promise<Task[]> }
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

  /** 生成成功后存一份，并把超出保留份数的旧报告删掉 */
  async function save(job: SummaryJob, body: Omit<z.infer<typeof SummaryReport>, 'md'> & { md: string }) {
    const record = await deps.reports.create(body)
    job.reportId = record.id
    job.md = body.md
    const all = (await deps.reports.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    for (const old of all.slice(SUMMARY_KEEP)) await deps.reports.remove(old.id)
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
    const chosen = input.projectIds.map((id) => all.find((p) => p.id === id)).filter((p): p is Project => !!p)
    if (!chosen.length) return failed(t('项目不存在'))
    const now = new Date()
    const { day } = todayWindow(now)
    const projects = collectDayProjects(
      await deps.tasks.list(),
      chosen.map((p) => ({ id: p.id, name: p.name })),
      now,
    )
    // 提示词里已经带着今天的记录，CLI 不需要再读代码：放在第一个有目录的项目里跑（只读权限），
    // 这样各 CLI 拿到的都是一个正常的项目工作目录，启动时读项目说明也不会出错
    const dir = chosen.find((p) => p.path)?.path || process.cwd()
    const taskCount = projects.reduce((n, p) => n + p.tasks.length, 0)
    log.info('summary', `用 ${def.name} 生成工作总结`, { day, projects: chosen.length, tasks: taskCount })

    let text = ''
    const errors: string[] = []
    let result: { ok: boolean; error?: string } | undefined
    const asks = askSession(`summary:${job.id}`, () => job.abort.abort())
    const r = await invokeCli({
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
      input: summaryPrompt({ day, projects }),
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
    }).finally(asks.done)
    if (r.killed === 'stopped') return failed(t('已停止'))
    if (r.killed === 'timeout') return failed(t('超过 {n} 分钟没有完成，已停止', { n: TIMEOUT / 60_000 }))
    if (r.spawnError)
      return failed(
        t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
          error: r.spawnError,
          cli: def.name,
          hint: def.installHint,
        }),
      )
    if (result ? !result.ok : r.code !== 0)
      return failed(
        t('{cli} 执行失败：{detail}', {
          cli: def.name,
          detail:
            [result?.error, ...errors, r.stderr.trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n') ||
            t('没有更多信息'),
        }),
      )
    const md = extractSummary(text)
    if (!md.trim()) return failed(t('{cli} 没有给出报告内容，可以再试一次', { cli: def.name }))
    try {
      await save(job, {
        day,
        projectIds: chosen.map((p) => p.id),
        projectNames: chosen.map((p) => p.name),
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
    const job: SummaryJob & { abort: AbortController; at: number } = {
      id: randomUUID(),
      status: 'running',
      projectIds: input.projectIds,
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
