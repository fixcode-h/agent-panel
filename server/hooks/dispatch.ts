import path from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent, Project, Task } from '../../shared/schema.ts'
import type { AgentCall } from '../../shared/engine.ts'
import type { BeforeEndDecision, BeforeEndInput, HookAnswer, HookFacts } from '../../shared/hooks.ts'
import {
  BUILTIN_HOOKS,
  builtinList,
  builtinOn,
  globMatch,
  hookApplies,
  type HookDef,
  type HookEventName,
  type HookInput,
  type HooksData,
  commandSegments,
} from '../../shared/hook-defs.ts'
import { activePlan, planNowText, planProgress } from '../../shared/plan.ts'
import { isChatMode } from '../../shared/conv-mode.ts'
import { DATA_DIR } from '../store.ts'
import { loadProjectLessons } from '../project-lessons.ts'
import { readHooks } from './store.ts'
import { noteTrigger, runHook } from './run.ts'
import { taskLog } from '../task-log.ts'
import {
  bugDeny,
  dangerDeny,
  longDeny,
  pushDeny,
  secretDeny,
  testScopeDeny,
  worktreeDeny,
  type GuardCtx,
} from './guards.ts'

/**
 * 一次 CLI 调用要装哪些钩子、各事件怎么回答（ADR 0049 第二期）。runner 只调这里，判断都在这里：
 * 内置钩子（BUILTIN_HOOKS）按开关、按这次调用的身份决定装不装；用户钩子按范围和匹配决定跑不跑。
 * 只看结构化的事实（身份、工具类别、文件路径、计划），不读模型回复的文字
 */

/** 只读的内置角色：调研、评审、排查分析（方案设计要写规范文件，不算只读） */
const READ_ONLY_ORIGINS = new Set(['builtin:explorer', 'builtin:reviewer', 'builtin:analyzer'])
/** 只读角色在命令行里也不该做的事：按命令前缀判断（不是按回复文字） */
const WRITE_COMMANDS = [
  'git commit',
  'git push',
  'git merge',
  'git rebase',
  'git reset',
  'npm install',
  'npm i ',
  'pnpm add',
  'pnpm install',
  'yarn add',
]

export interface HookCallCtx {
  task: Task
  project: Project
  agent: Pick<Agent, 'id' | 'name' | 'origin'>
  agents: Agent[]
  cliId: string
  cwd: string
  call: AgentCall
  /** 拦住、续跑时在对话里记一行（runner 负责：之后的输出另起一条） */
  mark: (reason: string) => void
}

const rel = (cwd: string, p: string) => {
  if (!p) return ''
  const r = path.relative(cwd, path.resolve(cwd, p))
  return r.startsWith('..') || path.isAbsolute(r) ? '' : r.replace(/\\/g, '/')
}
const inside = (dir: string, p: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(p))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/** 这次调用是哪种身份：只读角色、只统筹不动手的父对话，或者都不是 */
function identity(c: HookCallCtx): 'read-only' | 'coordinator' | '' {
  const orch = c.call.orch
  if (!orch) return ''
  if (READ_ONLY_ORIGINS.has(c.agent.origin)) return 'read-only'
  if (orch.coordinator && !orch.helper && !c.call.step && !c.task.parentTaskId && !isChatMode(c.task))
    return 'coordinator'
  return ''
}

/** 只读身份守卫：要改文件（和只读角色的写命令）时拒绝；父对话开了就地微改动时，改它登记的那几个文件放行 */
function readOnlyDeny(c: HookCallCtx, who: string, facts: HookFacts, extra: string[] = []): string {
  const tool = facts.tool
  if (!tool) return ''
  if (tool.kind === 'edit') {
    if (who === 'coordinator') {
      // 补丁一次能改好几个文件：每个都登记过才放行
      const files = (tool.paths.length ? tool.paths : [tool.path]).map((p) => rel(c.cwd, p))
      if (files.every((r) => r && c.task.inlineEdit?.files.includes(r))) return ''
      return '【面板】你是只统筹不动手的父对话，不直接改文件：改动交给子对话（create_conversation）；确实是几行以内的微小改动，先调用 begin_inline_edit 登记要改的文件。'
    }
    return '【面板】你是只读的角色，不改项目里的文件：把发现写进结果交回，要改的由派你的对话安排。'
  }
  if (who === 'read-only' && tool.kind === 'shell') {
    // 按段比：`cd 项目 && git commit` 也要拦
    const segs = commandSegments(String(tool.input.command ?? ''))
    const hit = [...WRITE_COMMANDS, ...extra.filter(Boolean)].find((w) => segs.some((c) => c.startsWith(w)))
    if (hit)
      return `【面板】你是只读的角色，不跑会改仓库或装依赖的命令（${hit.trim()}）：需要的话写进结果，由派你的对话安排。`
  }
  return ''
}

/** 临时文件位置守卫：写到盘符根目录下一两层、或面板的数据目录里时拒绝（项目目录、系统临时目录里照常） */
function tempFileDeny(c: HookCallCtx, facts: HookFacts, allow: string[] = []): string {
  const tool = facts.tool
  if (!tool || tool.kind !== 'edit') return ''
  for (const f of tool.paths.length ? tool.paths : [tool.path].filter(Boolean)) {
    const p = path.resolve(c.cwd, f)
    if (inside(c.cwd, p) || inside(tmpdir(), p) || allow.some((d) => d && inside(d, p))) continue
    const root = path.parse(p).root
    const depth = path.relative(root, p).split(path.sep).filter(Boolean).length
    if (inside(DATA_DIR, p) || depth <= 2)
      return `【面板】不要把文件写到 ${path.dirname(p)}：临时文件放项目的 .tmp/ 或系统临时目录（${tmpdir()}），用完清理。`
  }
  return ''
}

/** 压缩后补回计划：当前计划和进度、派单的目标（子对话的第一条交代）、全文在哪 */
function restoreText(task: Task): string {
  const plan = planNowText(task)
  const brief = task.parentTaskId ? (task.messages.find((m) => m.role === 'user' && !m.panel)?.text ?? '') : ''
  const parts = [
    plan && `## 当前计划\n${plan}`,
    brief &&
      `## 派单的目标\n${brief.length > 1500 ? `${brief.slice(0, 1500)}……（全文是这个对话的第一条消息）` : brief}`,
  ].filter(Boolean)
  return parts.length ? `【面板】上下文刚压缩过，下面是现在的进度，接着做：\n\n${parts.join('\n\n')}` : ''
}

/** 改文件后推送教训：每个对话里同一条教训只推一次 */
const pushed = new Map<string, Set<string>>()

export async function hookOptions(c: HookCallCtx): Promise<{
  beforeEnd?: (input: BeforeEndInput) => Promise<BeforeEndDecision>
  hookEvents?: HookEventName[]
  onHook?: (event: HookEventName, facts: HookFacts) => Promise<HookAnswer>
}> {
  if (!c.call.orch) return {}
  const data: HooksData = await readHooks()
  // 开关可以按项目单独设（覆盖全局，见 hook-builtins.ts）
  const on = (id: string) =>
    builtinOn(
      data,
      BUILTIN_HOOKS.find((h) => h.id === id)!,
      c.project.id,
    )
  const who = identity(c)
  const base: Omit<HookInput, 'event'> = {
    task: { id: c.task.id, title: c.task.title, parent: !c.task.parentTaskId },
    project: { id: c.project.id, path: c.cwd },
    agent: { id: c.agent.id, name: c.agent.name },
    cli: c.cliId,
  }
  // 这次调用范围对得上的用户钩子：装不装这个事件看它，工具类别、路径这些到触发时再看
  const mine = (event: HookEventName) => data.hooks.filter((h) => h.enabled && h.event === event && scopeOk(h, base))
  const lessons =
    on('push-lessons') && c.project.id
      ? (await loadProjectLessons(c.project, c.agents).catch(() => ({ lessons: [] }))).lessons.filter(
          (l) => l.enabled && l.paths.length,
        )
      : []
  // 工具前的内置守卫，按这个顺序问，第一个拒绝的说了算（第四期的几个见 guards.ts）
  const guard = (id: string): GuardCtx => ({
    task: c.task,
    project: c.project.id ? c.project : null,
    cwd: c.cwd,
    helper: !!c.call.orch?.helper,
    canBackground: !!c.call.orch?.canBackground,
    list: (key) => builtinList(data, id, key),
  })
  const GUARDS: [string, (g: GuardCtx, f: HookFacts) => string][] = [
    ['read-only-guard', (g, f) => (who ? readOnlyDeny(c, who, f, g.list('extra')) : '')],
    ['worktree-guard', worktreeDeny],
    ['bug-diagnosis-guard', bugDeny],
    ['push-guard', pushDeny],
    ['danger-guard', dangerDeny],
    ['test-scope-guard', testScopeDeny],
    ['long-command-guard', longDeny],
    ['secret-guard', secretDeny],
    ['temp-file-guard', (g, f) => tempFileDeny(c, f, g.list('allow'))],
  ]
  const guards = GUARDS.filter(([id]) => on(id) && (id !== 'read-only-guard' || who))
  const events: HookEventName[] = []
  if (guards.length || mine('tool.before').length) events.push('tool.before')
  if (lessons.length || mine('tool.after').length) events.push('tool.after')
  if ((on('restore-plan') && !c.call.orch.helper) || mine('context.restored').length) events.push('context.restored')

  const runUser = async (event: HookEventName, facts: HookFacts) => {
    const plan = activePlan(c.task)
    const p = plan ? planProgress(c.task, plan) : undefined
    const input: HookInput = {
      ...base,
      event,
      ...(facts.tool ? { tool: { kind: facts.tool.kind, name: facts.tool.name, input: facts.tool.input } } : {}),
      ...(p
        ? {
            plan: {
              done: p.done,
              total: p.total,
              current: plan!.steps.find((s) => s.status === 'running')?.title ?? '',
            },
          }
        : {}),
    }
    const r = rel(c.cwd, facts.tool?.path ?? '')
    const out: { deny?: string; block?: string; context: string[] } = { context: [] }
    for (const h of data.hooks.filter((x) => hookApplies(x, input, r))) {
      const res = await runHook(h, input, c.cwd)
      const failed = res.error ? (h.onError === 'deny' && event === 'tool.before' ? 'deny' : 'allow') : ''
      noteTrigger({
        at: new Date().toISOString(),
        hookId: h.id,
        name: h.name,
        event,
        taskId: c.task.id,
        result: res.error
          ? 'error'
          : res.out?.block
            ? 'block'
            : res.out?.deny
              ? 'deny'
              : res.out?.context
                ? 'context'
                : 'none',
        detail: res.error ?? res.out?.reason ?? res.out?.context ?? '',
        ms: res.ms,
      })
      if (failed === 'deny') out.deny ??= `【钩子「${h.name}」出错，按设置拒绝】${res.error}`
      if (res.out?.deny) out.deny ??= res.out.reason
      if (res.out?.block) out.block ??= res.out.reason
      if (res.out?.context) out.context.push(res.out.context)
      if (out.deny || out.block) break
    }
    return out
  }

  /** 内置钩子也记进「最近触发」：拦了什么、补了什么在设置页看得到，不用翻对话 */
  const noteBuiltin = (id: string, event: HookEventName, result: 'block' | 'deny' | 'context', detail: string) =>
    noteTrigger({
      at: new Date().toISOString(),
      hookId: `builtin:${id}`,
      name: BUILTIN_HOOKS.find((h) => h.id === id)?.name() ?? id,
      event,
      taskId: c.task.id,
      result,
      detail,
      ms: 0,
    })

  const builtinEnd = on('keep-going') ? c.call.beforeEnd : undefined
  const userEnd = mine('turn.beforeEnd').length > 0
  const beforeEnd =
    builtinEnd || userEnd
      ? async (input: BeforeEndInput): Promise<BeforeEndDecision> => {
          let d: BeforeEndDecision = builtinEnd ? await builtinEnd(input) : { block: false, why: 'builtin-off' }
          if (!d.block && userEnd) {
            const u = await runUser('turn.beforeEnd', {})
            if (u.block) d = { block: true, reason: u.block, why: 'user-hook' }
          }
          if (d.block && d.reason) {
            c.mark(d.reason)
            if (d.why !== 'user-hook') noteBuiltin('keep-going', 'turn.beforeEnd', 'block', d.reason)
          }
          return d
        }
      : undefined

  const onHook = async (event: HookEventName, facts: HookFacts): Promise<HookAnswer> => {
    if (event === 'tool.before') {
      for (const [id, fn] of guards) {
        const deny = fn(guard(id), facts)
        if (!deny) continue
        taskLog(c.task.id, '工具前钩子：拒绝', { guard: id, tool: facts.tool?.name, path: facts.tool?.path })
        noteBuiltin(id, event, 'deny', deny)
        return { deny: true, reason: deny }
      }
      const u = await runUser(event, facts)
      if (u.deny) return { deny: true, reason: u.deny }
      return u.context.length ? { context: u.context.join('\n\n') } : {}
    }
    if (event === 'tool.after') {
      const ctx: string[] = []
      const r = rel(c.cwd, facts.tool?.path ?? '')
      if (lessons.length && facts.tool?.kind === 'edit' && r) {
        const seen = pushed.get(c.task.id) ?? new Set<string>()
        pushed.set(c.task.id, seen)
        const hit = lessons.filter((l) => !seen.has(l.id) && l.paths.some((g) => globMatch(g, r)))
        for (const l of hit) seen.add(l.id)
        if (hit.length) noteBuiltin('push-lessons', event, 'context', `${r}：${hit.map((l) => l.title).join('、')}`)
        if (hit.length)
          ctx.push(
            `【面板】${r} 有相关的项目教训，照着做：\n${hit.map((l) => `- ${l.title}${l.rule ? `：${l.rule}` : ''}`).join('\n')}`,
          )
      }
      ctx.push(...(await runUser(event, facts)).context)
      return ctx.length ? { context: ctx.join('\n\n') } : {}
    }
    if (event === 'context.restored') {
      const ctx: string[] = []
      if (on('restore-plan') && !c.call.orch?.helper && facts.source === 'compact') {
        const text = restoreText(c.task)
        if (text) {
          ctx.push(text)
          taskLog(c.task.id, '压缩后补回计划', { chars: text.length })
          noteBuiltin('restore-plan', event, 'context', text.slice(0, 200))
        }
      }
      ctx.push(...(await runUser(event, facts)).context)
      return ctx.length ? { context: ctx.join('\n\n') } : {}
    }
    return {}
  }

  return { ...(beforeEnd ? { beforeEnd } : {}), ...(events.length ? { hookEvents: events, onHook } : {}) }
}

/** 只看范围（项目、角色、CLI），不看工具匹配：装不装 tool.* 只要范围对得上就装，具体匹不匹配到触发时再看 */
function scopeOk(h: HookDef, base: Omit<HookInput, 'event'>) {
  const s = h.scope
  return (
    (!s.projects.length || s.projects.includes(base.project.id)) &&
    (!s.agents.length || s.agents.includes(base.agent.id)) &&
    (!s.clis.length || s.clis.includes(base.cli))
  )
}
