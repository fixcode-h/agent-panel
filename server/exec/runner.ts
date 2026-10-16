import { stat } from 'node:fs/promises'
import type { Agent, CliStatus, Project, Settings, Task, TaskMessage, Workflow } from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { agentRun, cliSettings } from '../../shared/settings.ts'
import { runEngineTurn, type AgentCall, type AgentResult } from '../../shared/engine.ts'
import { gitChanges } from './git.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { childEnv, runProcess } from './process.ts'

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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 上下文窗口大小；CLI 不直接报告，按模型估计 */
function windowFor(cli: string, model: string) {
  if (/1m/i.test(model)) return 1_000_000
  if (cli === 'codex') return 272_000
  return 200_000
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
  const args = def.buildArgs({
    model,
    effort: run.effort,
    permission: cs.permission,
    extraArgs: [...cs.extraArgs, ...agent.extraArgs],
    resume,
    systemPrompt: def.systemPromptFlag && instructions ? instructions : undefined,
  })

  const parse = parserFor(cliId, cwd)
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

  const apply = (ev: CliEvent) => {
    switch (ev.type) {
      case 'session':
        task.sessions[sessionKey] = ev.id
        break
      case 'text_delta': {
        if (!cur && !ev.text.trim()) break
        const m = cur ?? newMsg()
        m.text += ev.text
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
        const prev = task.usage.agents[agentId]
        const m = ev.model || prev?.model || model
        task.usage.agents[agentId] = {
          context: ev.context ?? prev?.context ?? 0,
          window: windowFor(cliId, m),
          model: m,
        }
        task.usage.inputTokens += ev.addInput ?? 0
        task.usage.outputTokens += ev.addOutput ?? 0
        task.usage.costUsd += ev.addCost ?? 0
        break
      }
      case 'error':
        errors.push(ev.message)
        break
      case 'result':
        result = ev
        break
    }
    ctx.changed()
  }

  const r = await runProcess({
    command: cs.command,
    args,
    cwd,
    env: childEnv(cs.env),
    stdin: input,
    signal: ctx.signal,
    timeoutMs: settings.stepTimeoutMinutes * 60_000,
    onLine: (line) => {
      const t = line.trim()
      if (!t.startsWith('{')) return
      let obj: unknown
      try {
        obj = JSON.parse(t)
      } catch {
        return
      }
      for (const ev of parse(obj)) apply(ev)
    },
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
