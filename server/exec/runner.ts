import { stat } from 'node:fs/promises'
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
import { runEngineTurn, type AgentCall, type AgentResult } from '../../shared/engine.ts'
import { gitChanges } from './git.ts'
import { invokeCli } from './invoke.ts'
import type { AskReply, CliEvent } from './parsers.ts'
import { childEnv } from './process.ts'

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

/** 用户在任务页上回答了请求；找不到（已经结束、已回答过）时返回 false */
export function answerRequest(task: Task, id: string, r: AskReply, newId: () => string) {
  const fn = replies.get(id)
  const req = task.requests.find((x) => x.id === id)
  if (!fn || !req) return false
  replies.delete(id)
  task.requests = task.requests.filter((x) => x.id !== id)
  const what =
    req.kind === 'question'
      ? `回答了「${req.title}」：${r.answer ?? ''}`
      : `${r.allow ? '允许' : '拒绝'}了：${req.title}`
  task.messages.push({
    id: newId(),
    role: 'system',
    agentId: req.agentId,
    step: req.step,
    text: `你${what}`,
    tools: [],
    at: new Date().toISOString(),
  })
  fn(r)
  return true
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 上下文窗口大小；CLI 不直接报告，按模型估计 */
function windowFor(cli: string, model: string) {
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

/** 调用一次 Agent 对应的 CLI，把输出写进任务消息 */
async function runAgent(ctx: RealContext, call: AgentCall, retried = false): Promise<AgentResult> {
  const { agentId, prompt, sessionKey } = call
  const step = call.step?.id ?? ''
  const { task, settings, project } = ctx
  const agent = ctx.agents.find((a) => a.id === agentId)
  if (!agent) return { ok: false, error: '找不到执行这一步的 Agent，可能已被删除' }
  const run = agentRun(agent, settings)
  const cliId = run.cli
  const def = getCli(cliId)
  if (!def) return { ok: false, error: `未知的 CLI：${cliId}` }
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) return { ok: false, error: `${def.name} 在设置里被停用了` }
  if (!agent.enabled) return { ok: false, error: `Agent「${agent.name}」已停用` }
  const cwd = project.path
  const dir = await stat(cwd).catch(() => null)
  if (!dir?.isDirectory()) return { ok: false, error: `项目目录不存在：${cwd || '（未设置）'}` }

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
  }

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
        u.window = ev.window ?? windowFor(cliId, u.model || model)
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

  const r = await invokeCli({
    cliId,
    command: cs.command,
    build,
    cwd,
    env: childEnv(cs.env),
    input,
    signal: ctx.signal,
    timeoutMs: settings.stepTimeoutMinutes * 60_000,
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
    const changes = await gitChanges(cwd, task.baseline).catch(() => null)
    if (changes) task.changes = changes
  }
  ctx.changed(true)

  if (r.killed === 'stopped') return { ok: false, stopped: true, error: '已停止' }
  if (r.killed === 'timeout') return { ok: false, error: `超过 ${settings.stepTimeoutMinutes} 分钟没有完成，已停止` }
  if (r.spawnError)
    return {
      ok: false,
      error: `${r.spawnError}。请确认已安装 ${def.name}（${def.installHint}），或在设置里填写可执行文件的完整路径。`,
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
    return {
      ok: false,
      error: `${def.name} 执行失败${r.code !== null && r.code !== 0 ? `（退出码 ${r.code}）` : ''}：${clip(detail || '没有更多信息', 1500)}`,
    }
  }
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
  })
}
