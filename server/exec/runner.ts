import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Agent,
  AgentUsage,
  CliStatus,
  Project,
  Settings,
  Task,
  TaskMessage,
  ToolUse,
  Workflow,
} from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { agentPermission, agentRun, cliSettings } from '../../shared/settings.ts'
import { withTaskModel } from '../../shared/task.ts'
import { UPLOADS_DIR } from '../uploads.ts'
import { HANDOFF_DIR } from '../store.ts'
import { cachedModels, knownWindows } from '../models.ts'
import { runEngineTurn, type AgentCall, type AgentResult } from '../../shared/engine.ts'
import { gitChanges } from './git.ts'
import { invokeCli } from './invoke.ts'
import type { AskReply, CliEvent } from './parsers.ts'
import { childEnv } from './process.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'

export interface RealContext {
  task: Task
  agents: Agent[]
  workflows: Workflow[]
  workflow?: Workflow
  project: Project
  settings: Settings
  clis: CliStatus[]
  /** 本轮用户输入 */
  prompt: string
  signal: AbortSignal
  changed: (flush?: boolean) => void
  newId: () => string
  /** 任务所在目录是否是 git 仓库（决定改动从 git 读还是从工具调用里统计） */
  isGit: boolean
}

/** 等用户确认的请求：请求 id → 把结果交回 CLI 的函数。只在内存里，服务重启后 CLI 进程也不在了 */
const replies = new Map<string, (r: AskReply) => void>()

const stepTitle = (task: Task, id: string) => task.steps.find((s) => s.id === id)?.title ?? ''

/** 用户在任务页上回答了请求；找不到（已经结束、已回答过）时返回 false */
export function answerRequest(task: Task, id: string, r: AskReply, newId: () => string) {
  const fn = replies.get(id)
  const req = task.requests.find((x) => x.id === id)
  if (!fn || !req) return false
  replies.delete(id)
  task.requests = task.requests.filter((x) => x.id !== id)
  const what =
    req.kind === 'confirm'
      ? r.allow
        ? t('你确认了「{title}」的结果，接着往下执行', { title: stepTitle(task, req.step) })
        : t('你退回了「{title}」：{answer}', { title: stepTitle(task, req.step), answer: r.answer ?? '' })
      : req.kind === 'question'
        ? t('你回答了「{title}」：{answer}', { title: req.title, answer: r.answer ?? '' })
        : r.allow
          ? t('你允许了：{title}', { title: req.title })
          : t('你拒绝了：{title}', { title: req.title })
  task.messages.push({
    id: newId(),
    role: 'system',
    agentId: req.agentId,
    step: req.step,
    text: what,
    tools: [],
    at: new Date().toISOString(),
  })
  fn(r)
  return true
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/**
 * 上下文窗口大小。优先用 CLI 在执行中报告的（Claude Code 的 result.modelUsage、Codex 的 tokenUsage），
 * 其次是读模型列表时拿到的（Command Code 安装包里的模型目录、providers.json），最后才按模型名估计。
 */
function guessWindow(cli: string, model: string) {
  if (/1m/i.test(model)) return 1_000_000
  if (cli === 'codex') return 272_000
  return 200_000
}

/** 估算一段文字的 token 数：中日韩字符约一个字一个 token，其余约四个字符一个 token。只用于显示实时速度 */
export function estTokens(s: string) {
  const cjk = s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0
  return cjk + (s.length - cjk) / 4
}

/**
 * 实时输出速度：最近 3 秒内流式输出的 token 数 ÷ 时间。CLI 只在一次请求结束时才报告真实的输出 token，
 * 所以先按字数估算，拿到真实数字后按「真实 ÷ 估算」校准。
 */
function speedMeter(onIdle: () => void) {
  const WINDOW = 3000
  let samples: [number, number][] = []
  let est = 0
  let real = 0
  let lastAt = 0
  let genMs = 0
  let tps = 0
  const ratio = () => (est > 50 && real > 0 ? Math.min(3, Math.max(0.5, real / est)) : 1)
  const timer = setInterval(() => {
    if (tps && Date.now() - lastAt > 1500) {
      tps = 0
      samples = []
      onIdle()
    }
  }, 500)
  return {
    /** 流式输出了一段文字；返回新增的生成时间（毫秒） */
    add(text: string) {
      const now = Date.now()
      const gap = lastAt ? now - lastAt : 0
      // 两段输出间隔太久（在跑工具）不算生成时间
      const add = gap < 2000 ? gap : 0
      genMs += add
      lastAt = now
      est += estTokens(text)
      samples.push([now, est])
      while (samples.length > 2 && now - samples[1][0] > WINDOW) samples.shift()
      const [t0, e0] = samples[0]
      const dt = (now - t0) / 1000
      tps = dt > 0.3 ? ((est - e0) / dt) * ratio() : tps
      return add
    },
    real(n: number) {
      real += n
    },
    get tps() {
      return Math.round(tps * 10) / 10
    },
    stop() {
      clearInterval(timer)
      tps = 0
    },
  }
}

/** 连接断开时自动续接的次数上限 */
const MAX_NET_RETRIES = 2
const NETWORK_ERROR =
  /Connection error|APIConnectionError|Unable to connect to the API|Stream connection failed|stream (disconnected|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up|network (error|connection)/i

const NOT_LOGGED_IN =
  /Please run \/login|Invalid API key|not logged in|log ?in (again|first)|authentication[_ ](error|failed)|OAuth token (has )?expired|token (has )?expired|401 Unauthorized|codex login|refresh token/i

/** 各个 CLI 登录的方法：在终端里照着做 */
const loginHow = (cli: string) =>
  ({
    claude: t('运行 claude，在里面输入 /login'),
    codex: t('运行 codex login'),
    commandcode: t('运行 cmdc，按提示登录'),
  })[cli] ?? t('运行它并按提示登录')

/** 把常见的 CLI 报错翻译成能照着做的说明，原始输出另外附在后面 */
export function failureHints(detail: string, cli?: { id: string; name: string }) {
  const hints: string[] = []
  if (NOT_LOGGED_IN.test(detail))
    hints.push(
      t('· {cli} 好像没有登录，或者登录已经过期。请在终端里{how}，登录后回来点「继续执行」。', {
        cli: cli?.name ?? 'CLI',
        how: loginHow(cli?.id ?? ''),
      }),
    )
  const byok =
    /"([^"]+)" routes via Command Code; your providers\.json also declares it — use ((?:"[^"]+"(?: or )?)+)/.exec(
      detail,
    )
  if (byok) {
    const alt = [...byok[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(t(' 或 '))
    hints.push(
      t(
        '· 模型「{model}」走的是 Command Code 官方服务，不是你在 providers.json 里接的接口。想用自己的接口，请把模型换成「{alt}」（模型下拉的「配置文件」分组里）。',
        { model: byok[1], alt },
      ),
    )
  }
  if (NETWORK_ERROR.test(detail))
    hints.push(
      t(
        '· 和模型服务的连接中途断开了。常见于一次要输出很长的内容（例如写入一个大文件）时，连接被服务端或代理断开；可以点「继续执行」重试，或者换一个接口、让 Agent 分几次写。',
      ),
    )
  return hints
}

/** 调用一次 Agent 对应的 CLI，把输出写进任务消息 */
async function runAgent(ctx: RealContext, call: AgentCall, retried = false, netRetries = 0): Promise<AgentResult> {
  const { agentId, prompt, sessionKey } = call
  const step = call.step?.id ?? ''
  const { task, settings, project } = ctx
  const found = ctx.agents.find((a) => a.id === agentId)
  if (!found) return { ok: false, error: t('找不到执行这一步的 Agent，可能已被删除') }
  const agent = withTaskModel(found, task)
  const run = agentRun(agent, settings)
  const cliId = run.cli
  const def = getCli(cliId)
  if (!def) return { ok: false, error: t('未知的 CLI：{cli}', { cli: cliId }) }
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) return { ok: false, error: t('{cli} 在设置里被停用了', { cli: def.name }) }
  if (!agent.enabled) return { ok: false, error: t('Agent「{name}」已停用', { name: agent.name }) }
  const cwd = project.path
  const dir = await stat(cwd).catch(() => null)
  if (!dir?.isDirectory()) return { ok: false, error: t('项目目录不存在：{dir}', { dir: cwd || t('（未设置）') }) }

  const model = run.model
  const resume = task.sessions[sessionKey]
  const instructions = agent.instructions.trim()
  let input = prompt
  if (instructions && !def.systemPromptFlag && !resume) input = `## 你的角色\n${instructions}\n\n${prompt}`
  const build = {
    model,
    effort: run.effort,
    permission: agentPermission(agent, settings),
    extraArgs: [...cs.extraArgs, ...agent.extraArgs],
    resume,
    systemPrompt: def.systemPromptFlag && instructions ? instructions : undefined,
    // 附件在面板的数据目录里，不在项目目录下；Claude Code 读工作目录外的文件要先放行
    // 节点交接的完整结果也在数据目录里
    addDirs: [
      ...(task.messages.some((m) => m.attachments?.length) ? [UPLOADS_DIR] : []),
      ...(existsSync(path.join(HANDOFF_DIR, task.id)) ? [path.join(HANDOFF_DIR, task.id)] : []),
    ],
  }

  // 记下这次启动的命令，任务页里可以复制出来自己跑一遍排查问题；角色设定很长，用占位代替
  const argv = [
    cs.command,
    ...def.buildArgs(build).map((a) => (build.systemPrompt && a === build.systemPrompt ? t('<角色设定>') : a)),
  ]
  const owner = step ? task.steps.find((s) => s.id === step) : undefined
  if (owner) owner.command = argv
  else task.command = argv
  log.info('agent', `启动 ${def.name}`, { task: task.id, step, agent: agent.name, cwd, command: argv.join(' ') })

  // 只收集这次调用新产生的消息：同一个节点返工、续跑时，之前几次调用的输出不能再算进来
  const mine: TaskMessage[] = []
  let cur: TaskMessage | undefined
  const texts: string[] = []
  const errors: string[] = []
  let result: { ok: boolean; error?: string } | undefined
  const newMsg = () => {
    cur = { id: ctx.newId(), role: 'agent', agentId, step, text: '', tools: [], at: new Date().toISOString() }
    task.messages.push(cur)
    mine.push(cur)
    return cur
  }

  // 只用已经读过的模型列表（设置页、Agent 页打开时会读），不为了查窗口再跑一次 CLI
  const catalog = cachedModels(cliId)?.models ?? []
  const files = await knownWindows(cliId)
  const windowFor = (cli: string, m: string) =>
    catalog.find((x) => x.id === m || x.id.endsWith(`/${m}`))?.contextWindow ??
    files.get(m) ??
    files.get(m.slice(m.lastIndexOf('/') + 1)) ??
    guessWindow(cli, m)
  // CLI 报告过窗口后就以它为准，后面没带窗口的用量事件不要改回估计值
  let reported = false

  /** 这个 Agent 的用量记录，没有就建一条 */
  const au = (): AgentUsage => {
    const prev = task.usage.agents[agentId]
    if (prev) return prev
    return (task.usage.agents[agentId] = {
      context: 0,
      window: windowFor(cliId, model),
      model,
      tps: 0,
      outputTokens: 0,
      genMs: 0,
    })
  }
  const toolsById = new Map<string, ToolUse>()
  const meter = speedMeter(() => {
    au().tps = 0
    ctx.changed()
  })
  const streamed = (text: string) => {
    const u = au()
    u.genMs = (u.genMs ?? 0) + meter.add(text)
    u.tps = meter.tps
  }

  const apply = (ev: CliEvent) => {
    switch (ev.type) {
      case 'session':
        task.sessions[sessionKey] = ev.id
        break
      case 'thinking': {
        // 思考属于接下来的那段回复：当前消息已经有文字或工具时另起一条
        const m = !cur || cur.text.trim() || cur.tools.length ? newMsg() : cur
        m.thinking = ev.delta ? (m.thinking ?? '') + ev.text : ev.text
        streamed(ev.text)
        break
      }
      case 'text_delta': {
        if (!cur && !ev.text.trim()) break
        const m = cur ?? newMsg()
        m.text += ev.text
        streamed(ev.text)
        break
      }
      case 'text': {
        const m = cur ?? newMsg()
        m.text = m.text ? `${m.text.trimEnd()}\n\n${ev.text}` : ev.text
        break
      }
      case 'tool': {
        const m = !cur || cur.text.trim() ? newMsg() : cur
        m.text = ''
        m.tools.push(ev.tool)
        if (ev.id) toolsById.set(ev.id, ev.tool)
        if (ev.file && !ctx.isGit) {
          const old = task.changes.find((c) => c.path === ev.file!.path)
          if (old) {
            old.add += ev.file.add
            old.del += ev.file.del
          } else task.changes.push({ ...ev.file })
        }
        break
      }
      case 'usage': {
        const u = au()
        if (ev.model) u.model = ev.model
        if (ev.context !== undefined) u.context = ev.context
        if (ev.window) {
          u.window = ev.window
          reported = true
        } else if (!reported) u.window = windowFor(cliId, u.model || model)
        u.outputTokens = (u.outputTokens ?? 0) + (ev.addOutput ?? 0)
        meter.real(ev.addOutput ?? 0)
        const t = task.usage
        t.inputTokens += ev.addInput ?? 0
        t.outputTokens += ev.addOutput ?? 0
        t.cacheReadTokens = (t.cacheReadTokens ?? 0) + (ev.addCacheRead ?? 0)
        t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + (ev.addCacheWrite ?? 0)
        t.costUsd += ev.addCost ?? 0
        break
      }
      case 'tool_result': {
        // 工具的输出晚于调用到达，补到对应的那一行上
        const t = toolsById.get(ev.id)
        if (t) {
          if (ev.output) t.output = ev.output
          if (ev.failed) t.failed = true
          if (ev.patch) t.input = ev.patch
        }
        break
      }
      case 'todos':
        // 只替换这个 Agent 自己的清单，工作流里其他 Agent 的不动
        task.todos = [
          ...(task.todos ?? []).filter((x) => x.agentId !== agentId),
          ...ev.todos.map((x) => ({ ...x, agentId })),
        ]
        break
      case 'error':
        errors.push(ev.message)
        break
      case 'result':
        result = ev
        break
      case 'ask': {
        const id = ctx.newId()
        asked.push(id)
        replies.set(id, ev.reply)
        task.requests.push({
          id,
          step,
          agentId,
          kind: ev.kind,
          title: ev.title,
          detail: ev.detail,
          options: ev.options ?? [],
          at: new Date().toISOString(),
        })
        // 新的请求马上落盘，侧栏的铃铛和任务页立刻能看到
        ctx.changed(true)
        return
      }
    }
    ctx.changed()
  }
  const asked: string[] = []
  const idleMinutes = settings.idleTimeoutMinutes
  // 测试用：环境变量把「一分钟」缩短成几百毫秒，免得端到端测试真的等上几分钟
  const idleMs = idleMinutes * (Number(process.env.AGENT_PANEL_MINUTE_MS) || 60_000)

  const r = await invokeCli({
    cliId,
    command: cs.command,
    build,
    cwd,
    env: childEnv(cs.env),
    input,
    signal: ctx.signal,
    // 0 表示不限制
    timeoutMs: settings.stepTimeoutMinutes ? settings.stepTimeoutMinutes * 60_000 : 0,
    idle: idleMs
      ? {
          ms: idleMs,
          // 在等用户确认或回答时 CLI 本来就没有输出，不算卡住
          busy: () => task.requests.some((x) => asked.includes(x.id)),
          onWarn: () => {
            task.messages.push({
              id: ctx.newId(),
              role: 'system',
              agentId,
              step,
              text: t(
                '{cli} 已经 {n} 分钟没有任何输出，可能卡在登录、网络重连或交互式确认上。再过 {n} 分钟还没有输出会自动停止；也可以现在停止后检查一下。',
                { cli: def.name, n: idleMinutes },
              ),
              tools: [],
              at: new Date().toISOString(),
            })
            ctx.changed(true)
          },
        }
      : undefined,
    onEvent: apply,
    canAsk: true,
  }).finally(() => {
    meter.stop()
    // 进程结束了（完成、停止、超时），还没回答的请求作废
    for (const id of asked) replies.delete(id)
    task.requests = task.requests.filter((x) => !asked.includes(x.id))
    if (task.usage.agents[agentId]) task.usage.agents[agentId].tps = 0
  })

  for (const m of mine) if (m.text) texts.push(m.text)
  if (ctx.isGit) {
    const changes = await gitChanges(cwd, task.baseline, task.baseRef).catch(() => null)
    if (changes) task.changes = changes
  }
  ctx.changed(true)

  // 进程结束的情况都记一笔：退出码、为什么被停、最后的错误输出，排查问题时对得上页面上的报错
  if (r.killed || r.spawnError || r.code !== 0 || result?.ok === false)
    log.warn('agent', `${def.name} 进程结束`, {
      task: task.id,
      step,
      code: r.code,
      killed: r.killed,
      spawnError: r.spawnError,
      result: result?.error,
      errors: errors.join('\n'),
      stderr: r.stderr.trim().split('\n').slice(-20).join('\n'),
    })
  if (r.killed === 'stopped') return { ok: false, stopped: true, error: t('已停止') }
  if (r.killed === 'timeout')
    return { ok: false, error: t('超过 {n} 分钟没有完成，已停止', { n: settings.stepTimeoutMinutes }) }
  if (r.killed === 'idle') {
    const detail = [...errors, r.stderr.trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n')
    return {
      ok: false,
      error: [
        t('{cli} 连续 {n} 分钟没有任何输出，已停止。', { cli: def.name, n: idleMinutes * 2 }),
        ...failureHints(detail, def),
        detail ? `\n${t('最后的输出：')}\n${clip(detail, 1500)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (r.spawnError)
    return {
      ok: false,
      error: t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写可执行文件的完整路径。', {
        error: r.spawnError,
        cli: def.name,
        hint: def.installHint,
      }),
    }
  const failed = result ? !result.ok : r.code !== 0
  if (failed) {
    const detail = [result?.error, ...errors, r.stderr.trim().split('\n').slice(-6).join('\n')]
      .filter(Boolean)
      .join('\n')
    // 会话找不到时（例如 CLI 清理了历史），丢掉会话重新开始一次
    if (
      resume &&
      !retried &&
      /(no|not).{0,40}(session|conversation|thread)|(session|conversation|thread).{0,40}not found/i.test(detail)
    ) {
      delete task.sessions[sessionKey]
      // 新会话没有之前的上下文，要用完整提示
      return runAgent(ctx, { ...call, prompt: call.fresh ?? call.prompt }, true)
    }
    const hints = failureHints(detail, def)
    const head =
      r.code !== null && r.code !== 0
        ? t('{cli} 执行失败（退出码 {code}）：', { cli: def.name, code: r.code })
        : t('{cli} 执行失败：', { cli: def.name })
    const raw = clip(detail || t('没有更多信息'), 1500)
    const message = [head, ...hints, hints.length ? `\n${t('原始输出：')}\n${raw}` : raw].join('\n')
    // 连接中途断开（多半是输出很长时被服务端或代理断开）：有会话就续接让它接着做，最多两次。
    // 每次断开都把完整报错写进节点里再续接，不能悄悄重试，否则页面上只看到 Agent 反复说同一句话
    const session = task.sessions[sessionKey]
    if (NETWORK_ERROR.test(detail) && session && netRetries < MAX_NET_RETRIES && !ctx.signal.aborted) {
      task.messages.push({
        id: ctx.newId(),
        role: 'system',
        agentId,
        step,
        text: [
          message,
          '',
          t('正在自动续接会话重试（第 {n}/{max} 次）…', { n: netRetries + 1, max: MAX_NET_RETRIES }),
        ].join('\n'),
        tools: [],
        error: true,
        at: new Date().toISOString(),
      })
      log.warn('agent', `${def.name} 连接中断，自动续接第 ${netRetries + 1} 次`, { task: task.id, step, detail })
      ctx.changed(true)
      return runAgent(
        ctx,
        {
          ...call,
          prompt:
            '刚才和模型服务的连接中断了，请从中断的地方继续完成之前的任务，已经做完的不用重做。' +
            '如果是在一次写入很长的文件时断开的，请分几次写：先写前一部分，再分段追加，每次不要太长。',
        },
        retried,
        netRetries + 1,
      )
    }
    log.error('agent', `${def.name} 执行失败`, { task: task.id, step, code: r.code, detail })
    return {
      ok: false,
      error: netRetries ? [message, '', t('已自动续接 {n} 次，仍然失败。', { n: netRetries })].join('\n') : message,
    }
  }
  log.info('agent', `${def.name} 完成`, { task: task.id, step })
  return { ok: true, text: texts.join('\n\n') }
}

/** 真实执行一轮：调度交给执行引擎，调用 Agent 时启动对应 CLI */
export async function runRealTurn(ctx: RealContext) {
  ctx.task.simulated = false
  await runEngineTurn({
    task: ctx.task,
    agents: ctx.agents,
    workflows: ctx.workflows,
    workflow: ctx.workflow,
    prompt: ctx.prompt,
    changed: ctx.changed,
    newId: ctx.newId,
    runAgent: (call) => runAgent(ctx, call),
    confirm: (step, text) =>
      new Promise((resolve) => {
        const { task, signal } = ctx
        if (signal.aborted) return resolve(null)
        const id = ctx.newId()
        const done = (r: { allow: boolean; answer?: string } | null) => {
          signal.removeEventListener('abort', onAbort)
          replies.delete(id)
          task.requests = task.requests.filter((x) => x.id !== id)
          resolve(r)
        }
        // 停止任务时不再等，节点停在这里，继续执行时重新确认
        const onAbort = () => {
          done(null)
          ctx.changed(true)
        }
        signal.addEventListener('abort', onAbort)
        replies.set(id, (r) => done(r))
        task.requests.push({
          id,
          step: step.id,
          agentId: step.agentId,
          kind: 'confirm',
          title: t('「{title}」完成了，看一下结果再继续', { title: step.title }),
          detail: clip(text, 6000),
          options: [],
          at: new Date().toISOString(),
        })
        ctx.changed(true)
      }),
    saveHandoff: async (step, text) => {
      const dir = path.join(HANDOFF_DIR, ctx.task.id)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${step.id}.md`)
      await writeFile(file, `# ${step.title}\n\n${text}\n`)
      return file
    },
  })
}
