import { stat } from 'node:fs/promises'
import type { Agent, CliStatus, Project, Settings, Task, TaskMessage, TaskStep, Workflow } from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { agentCli, agentModel, cliSettings } from '../../shared/settings.ts'
import { findNode, taskStages } from '../../shared/flow.ts'
import { gitChanges } from './git.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { childEnv, runProcess } from './process.ts'

export interface RealContext {
  task: Task
  agents: Agent[]
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

type AgentResult = { ok: true; text: string } | { ok: false; stopped?: boolean; error: string }

const MAX_SUMMARY = 1500
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 上下文窗口大小；CLI 不直接报告，按模型估计 */
function windowFor(cli: string, model: string) {
  if (/1m/i.test(model)) return 1_000_000
  if (cli === 'codex') return 272_000
  return 200_000
}

function system(ctx: RealContext, text: string) {
  ctx.task.messages.push({
    id: ctx.newId(),
    role: 'system',
    agentId: '',
    step: -1,
    text,
    tools: [],
    at: new Date().toISOString(),
  })
}

function userRequests(task: Task) {
  const users = task.messages.filter((m) => m.role === 'user').map((m) => m.text)
  return { original: users[0] ?? '', extra: users.slice(1) }
}

/** 之前阶段每个节点的输出摘要 */
function stepSummaries(task: Task, beforeStage: number, agents: Agent[]) {
  const out: string[] = []
  task.steps.forEach((s, i) => {
    if (s.stage >= beforeStage) return
    const text = task.messages
      .filter((m) => m.role === 'agent' && m.step === i && m.text)
      .map((m) => m.text)
      .join('\n\n')
    const who = agents.find((a) => a.id === s.agentId)?.name ?? ''
    out.push(
      `### ${task.stages[s.stage]?.title ?? `阶段 ${s.stage + 1}`} · ${s.title}（${who}）\n${text ? clip(text, MAX_SUMMARY) : '（没有文字输出）'}`,
    )
  })
  return out.join('\n\n')
}

function stepPrompt(ctx: RealContext, i: number) {
  const { task, workflow, agents } = ctx
  const step = task.steps[i]
  const { original, extra } = userRequests(task)
  const node = findNode(workflow, step.id)
  const stageCount = new Set(task.steps.map((s) => s.stage)).size
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? ''
  const siblings = task.steps.filter((s, k) => s.stage === step.stage && k !== i)
  return [
    `你正在执行工作流「${workflow?.name ?? ''}」第 ${step.stage + 1}/${stageCount} 阶段「${task.stages[step.stage]?.title ?? ''}」里的节点：${step.title}`,
    `## 用户需求\n${original}`,
    extra.length ? `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}` : '',
    workflow?.document.trim() ? `## 工作流说明\n${workflow.document.trim()}` : '',
    node?.instructions.trim() ? `## 本节点要做的事\n${node.instructions.trim()}` : '',
    siblings.length
      ? `## 同时进行的节点\n下面这些节点和你并行执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings.map((s) => `- ${s.title}（${name(s.agentId)}）`).join('\n')}`
      : '',
    step.stage > 0 ? `## 之前阶段的结果\n${stepSummaries(task, step.stage, agents)}` : '',
    `## 要求\n只完成本节点「${step.title}」，不要做其他节点的工作。完成后用中文简要总结：做了什么、改了哪些文件、有没有遗留问题。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function followUpPrompt(ctx: RealContext) {
  const { original } = userRequests(ctx.task)
  if (ctx.task.mode === 'chat') return ctx.prompt
  return [
    `用户对任务「${ctx.task.title}」提出了追加要求：\n${ctx.prompt}`,
    `## 任务的原始需求\n${original}`,
    ctx.workflow?.document.trim() ? `## 工作流说明\n${ctx.workflow.document.trim()}` : '',
    '工作流的各个节点已经完成。请按追加要求直接修改，必要时自己验证；完成后用中文简要说明改了什么。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 调用一次 Agent 对应的 CLI，把输出写进任务消息 */
async function runAgent(
  ctx: RealContext,
  agentId: string,
  step: number,
  prompt: string,
  /** 会话键：工作流节点用节点 id，对话和追加要求用 Agent id */
  sessionKey: string,
  retried = false,
): Promise<AgentResult> {
  const { task, settings, project } = ctx
  const agent = ctx.agents.find((a) => a.id === agentId)
  if (!agent) return { ok: false, error: '找不到执行这一步的 Agent，可能已被删除' }
  const cliId = agentCli(agent, settings)
  const def = getCli(cliId)
  if (!def) return { ok: false, error: `未知的 CLI：${cliId}` }
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) return { ok: false, error: `${def.name} 在设置里被停用了` }
  if (!agent.enabled) return { ok: false, error: `Agent「${agent.name}」已停用` }
  const cwd = project.path
  const dir = await stat(cwd).catch(() => null)
  if (!dir?.isDirectory()) return { ok: false, error: `项目目录不存在：${cwd || '（未设置）'}` }

  const model = agentModel(agent, settings)
  const resume = task.sessions[sessionKey]
  const instructions = agent.instructions.trim()
  let input = prompt
  if (instructions && !def.systemPromptFlag && !resume) input = `## 你的角色\n${instructions}\n\n${prompt}`
  const args = def.buildArgs({
    model,
    permission: cs.permission,
    extraArgs: [...cs.extraArgs, ...agent.extraArgs],
    resume,
    systemPrompt: def.systemPromptFlag && instructions ? instructions : undefined,
  })

  const parse = parserFor(cliId, cwd)
  let cur: TaskMessage | undefined
  const texts: string[] = []
  const errors: string[] = []
  let result: { ok: boolean; error?: string } | undefined
  const newMsg = () => {
    cur = { id: ctx.newId(), role: 'agent', agentId, step, text: '', tools: [], at: new Date().toISOString() }
    task.messages.push(cur)
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

  for (const m of task.messages) if (m.agentId === agentId && m.step === step && m.text) texts.push(m.text)
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
      return runAgent(ctx, agentId, step, prompt, sessionKey, true)
    }
    return {
      ok: false,
      error: `${def.name} 执行失败${r.code !== null && r.code !== 0 ? `（退出码 ${r.code}）` : ''}：${clip(detail || '没有更多信息', 1500)}`,
    }
  }
  return { ok: true, text: texts.join('\n\n') }
}

function finish(ctx: RealContext, r: Extract<AgentResult, { ok: false }>) {
  for (const s of ctx.task.steps)
    if (s.status === 'running') {
      s.status = r.stopped ? 'pending' : 'failed'
      s.endedAt = new Date().toISOString()
    }
  system(ctx, r.stopped ? '已停止。可以在下面输入新的要求继续。' : r.error)
  ctx.task.status = r.stopped ? 'stopped' : 'failed'
  ctx.changed(true)
}

/** 真实执行一轮：工作流按阶段推进（阶段内并行），都完成后由主 Agent 处理追加要求；对话模式直接发给对应 Agent */
export async function runRealTurn(ctx: RealContext) {
  const { task } = ctx
  task.status = 'running'
  task.simulated = false
  ctx.changed(true)

  if (task.mode === 'workflow' && task.steps.some((s) => s.status !== 'done')) {
    for (const stage of taskStages(task)) {
      const todo = stage.steps.filter(({ step }) => step.status !== 'done')
      if (!todo.length) continue
      for (const { step } of todo) {
        step.status = 'running'
        step.startedAt = new Date().toISOString()
        step.endedAt = ''
      }
      ctx.changed(true)
      // 同一阶段的节点同时启动；某个节点失败时，其余节点仍会跑完
      const results = await Promise.all(
        todo.map(async ({ step, i }) => {
          const r = await runAgent(ctx, step.agentId, i, stepPrompt(ctx, i), step.id)
          step.status = r.ok ? 'done' : r.stopped ? 'pending' : 'failed'
          step.endedAt = new Date().toISOString()
          ctx.changed(true)
          return { step, r }
        }),
      )
      const failed = results.filter((x) => !x.r.ok) as { step: TaskStep; r: Extract<AgentResult, { ok: false }> }[]
      if (failed.length) {
        const stopped = failed.find((x) => x.r.stopped)
        if (stopped) return finish(ctx, stopped.r)
        const error =
          failed.length === 1 && todo.length === 1
            ? failed[0].r.error
            : failed.map((x) => `「${x.step.title}」${x.r.error}`).join('\n\n')
        return finish(ctx, { ok: false, error })
      }
    }
  } else {
    const who = task.mode === 'chat' ? task.agentId : (ctx.workflow?.mainAgentId ?? task.steps[0]?.agentId ?? '')
    // 追加要求：续接主 Agent 最近执行过的节点的会话，带上它之前的上下文
    if (task.mode === 'workflow' && !task.sessions[who]) {
      const last = [...task.steps].reverse().find((s) => s.agentId === who && task.sessions[s.id])
      if (last) task.sessions[who] = task.sessions[last.id]
    }
    const r = await runAgent(ctx, who, -1, followUpPrompt(ctx), who)
    if (!r.ok) return finish(ctx, r)
  }
  task.status = 'done'
  ctx.changed(true)
}
