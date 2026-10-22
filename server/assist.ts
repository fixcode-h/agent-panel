import { askSession, setAskUser } from './asks.ts'
import { Hono, type Context } from 'hono'
import { mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  AssistInput,
  buildAssistPrompt,
  extractJson,
  resolveProposal,
  type AssistContext,
  type AssistJob,
  type AssistMessage,
} from '../shared/assist.ts'
import { derivedParams } from '../shared/agent-params.ts'
import { getCli } from '../shared/clis.ts'
import type { Agent, Category, Project, TaskMessage, ToolUse, Workflow } from '../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { detectClis } from './detect.ts'
import { failureHints } from './exec/runner.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { getSettings } from './settings.ts'
import { resolvePath } from './fs.ts'
import { t } from '../shared/i18n.ts'
import { readGlobalLessons } from './lessons.ts'

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 设置里的额外参数可能放宽权限（跳过确认、换沙箱），生成配置时去掉，保证只读 */
export function safeArgs(args: string[]) {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^--(dangerously-|yolo|full-auto|bypass)/.test(a) || a === '-y') continue
    if (/^(--permission-mode|--approval-mode|--sandbox|-s)$/.test(a)) {
      i++
      continue
    }
    if (/^--(permission-mode|approval-mode|sandbox)=/.test(a)) continue
    if (a === '-c' && /^sandbox_mode|^approval_policy/.test(args[i + 1] ?? '')) {
      i++
      continue
    }
    out.push(a)
  }
  return out
}
const TIMEOUT = 5 * 60_000

/** AI 创建 / 优化 Agent 和工作流：调用本机 CLI 生成，校验格式，不合格时让 CLI 自己修正一次 */
export function assistApi(deps: {
  agents: Lister<Agent>
  categories: Lister<Category>
  workflows: Lister<Workflow>
  projects: Lister<Project>
}) {
  const jobs = new Map<string, AssistJob & { abort: AbortController; at: number }>()
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  const view = ({ abort, at, ...j }: AssistJob & { abort: AbortController; at: number }): AssistJob => j

  // 一小时前的结果清掉
  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 600_000).unref()

  async function run(job: AssistJob & { abort: AbortController }, input: AssistInput, ctx: AssistContext) {
    const settings = await getSettings()
    const def = getCli(input.cli)!
    const cs = cliSettings(settings, input.cli)
    const run = agentRun({ cli: input.cli, model: input.model, effort: input.effort }, settings)
    const installed = (await detectClis()).filter((c) => c.installed && c.enabled).map((c) => c.id)
    // 只读分析（params / teststeps）在项目目录里执行，让 CLI 自己看代码；
    // 其他生成在临时目录里执行，碰不到项目文件
    const project = input.projectId ? await deps.projects.get(input.projectId) : null
    // 分析项目时项目可能还没保存（新建项目的设置里），目录由页面带来
    const projectDir = project?.path ?? (input.kind === 'project' ? (input.subject.path ?? '') : '')
    const readOnlyProject =
      (input.kind === 'params' || input.kind === 'teststeps' || input.kind === 'project') && !!projectDir
    const cwd = readOnlyProject ? resolvePath(projectDir) : path.join(tmpdir(), 'agent-panel-assist')
    if (!readOnlyProject) await mkdir(cwd, { recursive: true })
    // 项目目录可能在只读分析期间被删掉：先确认还在，避免 CLI 启动就失败
    if (
      readOnlyProject &&
      !(await stat(cwd)
        .then((s) => s.isDirectory())
        .catch(() => false))
    )
      return fail(job, t('项目目录不存在：{dir}', { dir: cwd }))
    let messages: AssistMessage[] = input.messages

    // 消息流的拼法和任务页一样：思考、工具各自成段，文字接在后面；每一段的文字只保留 JSON 前面的说明
    const msgs: (TaskMessage & { raw: string })[] = []
    job.messages = msgs
    let cur: (typeof msgs)[number] | undefined
    const toolsById = new Map<string, ToolUse>()
    const newMsg = () => {
      cur = {
        id: randomUUID(),
        role: 'agent',
        agentId: '',
        step: '',
        text: '',
        raw: '',
        tools: [],
        at: new Date().toISOString(),
      }
      msgs.push(cur)
      return cur
    }
    const setRaw = (m: (typeof msgs)[number], raw: string) => {
      m.raw = raw
      m.text = raw.split('```')[0].trimEnd()
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      job.attempt = attempt
      cur = undefined
      if (attempt > 1)
        msgs.push({
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: t('格式不对，已让 Agent 修正。'),
          raw: '',
          tools: [],
          at: new Date().toISOString(),
        })
      job.thinking = undefined
      job.tools = undefined
      job.outChars = 0
      let text = ''
      const errors: string[] = []
      let result: { ok: boolean; error?: string } | undefined
      const asks = askSession(`assist:${job.id}`)
      const r = await invokeCli({
        askUser: asks.askUser,
        onAsk: asks.onAsk,
        cliId: input.cli,
        command: cs.command,
        build: {
          // 默认模型可能是「@high」这样的档位，要换成具体模型和思考强度
          model: run.model,
          effort: run.effort,
          // 审批按设置里的权限：CLI 要确认时弹出卡片等用户
          // 在项目目录里只读分析时用 CLI 的只读权限，保证不会改项目文件
          permission: readOnlyProject ? def.readOnly || cs.permission : cs.permission,
          extraArgs: cs.extraArgs,
        },
        cwd,
        env: childEnv(cs.env),
        input: buildAssistPrompt(input.kind, ctx, messages, installed),
        signal: job.abort.signal,
        timeoutMs: TIMEOUT,
        onEvent: (ev) => {
          if (ev.type === 'thinking') {
            const m = !cur || cur.raw.trim() || cur.tools.length ? newMsg() : cur
            m.thinking = ev.delta ? (m.thinking ?? '') + ev.text : ev.text
          } else if (ev.type === 'text_delta') {
            if (cur || ev.text.trim()) setRaw(cur ?? newMsg(), (cur?.raw ?? '') + ev.text)
          } else if (ev.type === 'text') {
            const m = cur ?? newMsg()
            setRaw(m, m.raw ? `${m.raw.trimEnd()}\n\n${ev.text}` : ev.text)
          } else if (ev.type === 'tool') {
            const m = !cur || cur.raw.trim() ? newMsg() : cur
            m.tools.push(ev.tool)
            if (ev.id) toolsById.set(ev.id, ev.tool)
          } else if (ev.type === 'tool_result') {
            const t = toolsById.get(ev.id)
            if (t) {
              if (ev.output) t.output = ev.output
              if (ev.failed) t.failed = true
              if (ev.patch) t.input = ev.patch
            }
          }
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
          else if (ev.type === 'error') errors.push(ev.message)
          else if (ev.type === 'thinking')
            job.thinking = (ev.delta ? (job.thinking ?? '') + ev.text : ev.text).slice(-1500)
          else if (ev.type === 'tool') job.tools = [...(job.tools ?? []), ev.tool.label].slice(-5)
          else if (ev.type === 'result') result = ev
          // 执行中只显示说明部分，JSON 写到一半时不显示，只显示写了多少
          job.text = text.split('```')[0].trim()
          job.outChars = text.length
        },
      }).finally(asks.done)
      if (r.killed === 'stopped') return fail(job, t('已停止'))
      if (r.killed === 'timeout') return fail(job, t('超过 5 分钟没有完成，已停止'))
      if (r.spawnError)
        return fail(
          job,
          t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
            error: r.spawnError,
            cli: def.name,
            hint: def.installHint,
          }),
        )
      if (result ? !result.ok : r.code !== 0) {
        const detail =
          [result?.error, ...errors, r.stderr.trim().split('\n').slice(-4).join('\n')].filter(Boolean).join('\n') ||
          t('没有更多信息')
        return fail(
          job,
          [t('{cli} 执行失败：{detail}', { cli: def.name, detail }), ...failureHints(detail, def)].join('\n\n'),
        )
      }

      const ex = extractJson(text)
      job.text = ex.rest
      const res = ex.error ? { error: ex.error } : resolveProposal(input.kind, ex.json, ctx)
      if (res.proposal) {
        job.proposal = res.proposal
        job.raw = JSON.stringify(ex.json, null, 2)
        job.status = 'done'
        return
      }
      if (attempt === 2)
        return fail(job, t('{cli} 两次都没有按格式输出：{error}', { cli: def.name, error: res.error ?? '' }))
      // 把错误告诉 CLI，让它修正一次
      messages = [
        ...messages,
        { role: 'assistant', text },
        { role: 'user', text: `你上面的 JSON 不符合要求：${res.error}\n请修正后重新输出完整的说明和 JSON。` },
      ]
    }
  }

  function fail(job: AssistJob, error: string) {
    job.status = 'failed'
    job.error = error
  }

  return new Hono()
    .post('/', async (c) => {
      const p = AssistInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const input = p.data
      if (!getCli(input.cli)) return bad(c, t('未知的 Agent：{cli}', { cli: input.cli }))
      if (!cliSettings(await getSettings(), input.cli).enabled)
        return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(input.cli)!.name }))
      const target = input.targetId
        ? input.kind === 'agent'
          ? await deps.agents.get(input.targetId)
          : await deps.workflows.get(input.targetId)
        : undefined
      if (input.targetId && !target)
        return bad(c, input.kind === 'agent' ? t('要优化的角色不存在') : t('要优化的工作流不存在'), 404)
      const settings = await getSettings()
      const agents = await deps.agents.list()
      const workflows = await deps.workflows.list()
      // params / teststeps：只读分析一个项目。targetId 是要配的工作流，subject.agentId 是只配一个 Agent 分组
      const analyzeProject = input.kind === 'params' || input.kind === 'teststeps' || input.kind === 'project'
      if (input.kind === 'project' && !input.projectId && !input.subject.path?.trim())
        return bad(c, t('先选好项目目录'))
      // lessons：只看项目的教训，不进项目目录
      const project =
        (analyzeProject || input.kind === 'lessons') && input.projectId
          ? await deps.projects.get(input.projectId)
          : null
      if ((analyzeProject || input.kind === 'lessons') && input.projectId && !project)
        return bad(c, t('项目不存在'), 404)
      const wf = input.kind === 'params' && input.targetId ? workflows.find((w) => w.id === input.targetId) : undefined
      const ctx: AssistContext = {
        agents,
        categories: (await deps.categories.list()).filter((c) => c.scope !== 'workflow'),
        workflows,
        rules:
          input.kind === 'agent'
            ? settings.assist.agentRules
            : input.kind === 'workflow'
              ? settings.assist.workflowRules
              : '',
        subject: input.subject,
        target: target ?? undefined,
        defaultCli: defaultCli(settings),
        ...(project && analyzeProject ? { projectPath: project.path, projectName: project.name } : {}),
        ...(!project && input.kind === 'project' ? { projectPath: input.subject.path!.trim() } : {}),
        ...(project && input.kind === 'lessons'
          ? { projectName: project.name, projectLessons: project.lessons, globalLessons: await readGlobalLessons() }
          : {}),
        ...(wf ? { paramSpec: derivedParams(wf, agents), target: wf } : {}),
        ...(input.subject.agentId ? { paramAgentId: input.subject.agentId } : {}),
        platform: process.platform,
      }
      const job = {
        id: randomUUID(),
        kind: input.kind,
        targetId: input.targetId,
        status: 'running' as const,
        text: '',
        attempt: 1,
        startedAt: Date.now(),
        abort: new AbortController(),
        at: Date.now(),
      }
      jobs.set(job.id, job)
      setAskUser(`assist:${job.id}`, input.askUser)
      run(job, input, ctx)
        .catch((e) => fail(job, (e as Error).message))
        .finally(() => (job.at = Date.now()))
      return c.json(view(job), 201)
    })
    .get('/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : bad(c, t('找不到这次生成，可能已过期'), 404)
    })
    .post('/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return bad(c, t('找不到这次生成'), 404)
      j.abort.abort()
      return c.json(view(j))
    })
}
