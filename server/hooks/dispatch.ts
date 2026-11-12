import { knownSlow } from '../command-times.ts'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent, Project, Task } from '../../shared/schema.ts'
import type { AgentCall } from '../../shared/engine-host.ts'
import { traceCli } from '../exec/cli-trace.ts'
import type { BeforeEndDecision, BeforeEndInput, HookAnswer, HookFacts, HookToolScope } from '../../shared/hooks.ts'
import {
  globMatch,
  hookApplies,
  type HookDef,
  type HookEventName,
  type HookInput,
  type HooksData,
  commandSegments,
} from '../../shared/hook-defs.ts'
import { BUILTIN_HOOKS, builtinList, builtinNumber, builtinOn } from '../../shared/hook-builtins.ts'
import { activePlan, planNowText, planProgress } from '../../shared/plan.ts'
import { isChatMode } from '../../shared/conv-mode.ts'
import { newPace, planPaceHint, type PaceState } from '../../shared/plan-pace.ts'
import { DATA_DIR } from '../store.ts'
import { loadProjectLessons } from '../projects/lessons.ts'
import { recordKnowledgeHits } from '../knowledge-hits.ts'
import { readHooks } from './store.ts'
import { noteTrigger, runHook } from './run.ts'
import { activePluginHooks, isPluginHook, runPluginHook } from '../plugins/contrib.ts'
import { taskLog } from '../tasks/log.ts'
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
import { bigOutputHint, bigReadDeny } from './guards-context.ts'
import { checkConfigDeny, readBeforeEditDeny } from './guards-edit.ts'
import { taskMap } from '../runtime/task-state.ts'

/**
 * 一次 CLI 调用要装哪些钩子、各事件怎么回答（ADR 0049 第二期）。runner 只调这里，判断都在这里：
 * 内置钩子（BUILTIN_HOOKS）按开关、按这次调用的身份决定装不装；用户钩子按范围和匹配决定跑不跑。
 * 只看结构化的事实（身份、工具类别、文件路径、计划），不读模型回复的文字
 */

/** 只读的内置角色：调研、评审、排查分析（方案设计要写规范文件，不算只读） */
const READ_ONLY_ORIGINS = new Set(['builtin:explorer', 'builtin:reviewer', 'builtin:analyzer']) // 模块状态：常量，加载后不改
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

/**
 * 临时文件位置：项目根的 .tmp/（AGENTS.md 约定的临时目录，已在 .gitignore），或系统临时目录里、又不在项目里的路径。
 * 项目本身放在系统临时目录里时（测试、临时克隆），项目里的文件照样算改项目
 */
function scratchPath(c: HookCallCtx, f: string): boolean {
  const p = path.resolve(c.cwd, f)
  const roots = [c.cwd, c.project?.path].filter((x): x is string => !!x)
  if (roots.some((r) => inside(path.join(r, '.tmp'), p))) return true
  return inside(tmpdir(), p) && !roots.some((r) => inside(r, p))
}

/** 只读身份守卫：要改文件（和只读角色的写命令）时拒绝；父对话开了就地微改动时，改它登记的那几个文件放行 */
function readOnlyDeny(c: HookCallCtx, who: string, facts: HookFacts, extra: string[] = []): string {
  const tool = facts.tool
  if (!tool) return ''
  if (tool.kind === 'edit') {
    const all = (tool.paths.length ? tool.paths : [tool.path]).filter(Boolean)
    // 一次性的临时脚本、草稿（项目的 .tmp/、系统临时目录）不算改项目：以前一律拦，模型只好改用 stdin 喂脚本
    if (all.length && all.every((p) => scratchPath(c, p))) return ''
    if (who === 'coordinator') {
      // 补丁一次能改好几个文件：每个都登记过才放行
      const files = (tool.paths.length ? tool.paths : [tool.path]).map((p) => rel(c.cwd, p))
      // 插件工具算不出要改哪些文件时 paths 是空的：说不清改什么就不算登记过
      if (files.length && files.every((r) => r && c.task.inlineEdit?.files.includes(r))) return ''
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
const pushed = taskMap<Set<string>>('hooks.dispatch 推过的教训') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再提醒一次
/** 原地打转提醒：每个对话里每条命令连续失败了几次（成功一次就清零），提醒过的记在 hinted 里不再重复 */
const fails = taskMap<Map<string, number>>('hooks.dispatch 命令连续失败') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再提醒一次
/** 计划没跟上提醒：每个对话在数哪一项、动了几次手、提醒过什么（见 shared/plan-pace.ts） */
const paces = taskMap<PaceState>('hooks.dispatch 计划进度提醒') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再提醒一次
/** 改完没验证：每个对话里按哪条输入问过（同一条输入只问一次） */
const verified = taskMap<string>('hooks.dispatch 改完没验证') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再提醒一次

/**
 * 这条输入以来改过文件、最后一次改之后一条命令都没跑过：返回这条输入的 id，不该问返回空。
 * 只看工具的类别（edit / run），不看回复文字；自检过（钩子、提醒的那一行）之后又没动过的不再问
 */
export function unverifiedEdit(task: Pick<Task, 'messages'>): string {
  const msgs = task.messages
  let at = -1
  msgs.forEach((m, i) => {
    if (m.role === 'user' && !m.panel) at = i
  })
  if (at < 0) return ''
  let lastEdit = -1
  let lastRun = -1
  let n = 0
  msgs.slice(at + 1).forEach((m) => {
    if (m.panel === 'hook' || m.panel === 'nudge') lastRun = Math.max(lastRun, n)
    for (const x of m.role === 'agent' ? m.tools : []) {
      n++
      if (x.kind === 'edit') lastEdit = n
      else if (x.kind === 'run') lastRun = n
    }
  })
  return lastEdit > 0 && lastRun < lastEdit ? msgs[at].id : ''
}

export async function hookOptions(c: HookCallCtx): Promise<{
  beforeEnd?: (input: BeforeEndInput) => Promise<BeforeEndDecision>
  hookEvents?: HookEventName[]
  /** 工具前 / 工具后各自关心哪几类工具：能按工具名过滤的 CLI 只对这几类触发（见 shared/hooks.ts 的 toolMatcher） */
  hookTools?: HookToolScope
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
  // 用户钩子加上开着的插件带的钩子（插件关掉就不在这里，见 server/plugins/contrib.ts）
  const all: HookDef[] = [...data.hooks, ...activePluginHooks(data)]
  // 这次调用范围对得上的用户钩子：装不装这个事件看它，工具类别、路径这些到触发时再看
  const mine = (event: HookEventName) => all.filter((h) => h.enabled && h.event === event && scopeOk(h, base))
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
    slowKnown: (seg) => knownSlow(c.task.projectId ?? '', seg),
  })
  const GUARDS: [string, (g: GuardCtx, f: HookFacts) => string][] = [
    ['read-only-guard', (g, f) => (who ? readOnlyDeny(c, who, f, g.list('extra')) : '')],
    ['worktree-guard', worktreeDeny],
    ['bug-diagnosis-guard', bugDeny],
    ['push-guard', pushDeny],
    ['danger-guard', dangerDeny],
    ['test-scope-guard', testScopeDeny],
    ['long-command-guard', longDeny],
    ['big-read-guard', (_g, f) => bigReadDeny(c.cwd, c.task.id, builtinNumber(data, 'big-read-guard', 'kb'), f)],
    ['secret-guard', secretDeny],
    ['temp-file-guard', (g, f) => tempFileDeny(c, f, g.list('allow'))],
    // 借鉴 ECC 的两个（严格档）：放在最后，前面的守卫说了不许改的不必再提醒先读
    ['check-config-guard', (g, f) => checkConfigDeny(c.cwd, c.task.id, g.list('extra'), f)],
    ['read-before-edit', (_g, f) => readBeforeEditDeny(c.cwd, c.task, f)],
  ]
  const guards = GUARDS.filter(([id]) => on(id) && (id !== 'read-only-guard' || who))
  // 设置里按 CLI 关掉的事件（比如中转站上 Codex 的工具后）：内置的、自己的钩子都不装
  const off = new Set(data.cliOff[c.cliId] ?? [])
  const events: HookEventName[] = []
  if (guards.length || mine('tool.before').length) events.push('tool.before')
  // 计划没跟上提醒：只给有执行计划的对话（项目里的对话，不含子任务、Chat 页）
  const pace = on('plan-pace') && !!c.call.orch.plans
  const bigOut = on('big-output-hint') && builtinNumber(data, 'big-output-hint', 'chars') > 0
  if (lessons.length || on('loop-hint') || pace || bigOut || mine('tool.after').length) events.push('tool.after')
  if ((on('restore-plan') && !c.call.orch.helper) || mine('context.restored').length) events.push('context.restored')
  for (const e of [...events]) if (off.has(e)) events.splice(events.indexOf(e), 1)
  // 各事件关心哪几类工具：内置的守卫、提醒只看改文件和跑命令（guards.ts、plan-pace 的 WORK、loopHint、教训），
  // 用户钩子按自己的匹配范围（任意工具就是全部）。读文件、搜索没人管时，能过滤的 CLI 就不再为它们跑钩子
  const userKinds = (event: HookEventName) => mine(event).map((h) => h.match.tool)
  const hookTools: HookToolScope = {
    'tool.before': [
      ...(guards.length ? (['edit', 'shell'] as const) : []),
      // 读大文件守卫要看读文件工具
      ...(guards.some(([id]) => id === 'big-read-guard') ? (['read'] as const) : []),
      ...userKinds('tool.before'),
    ],
    'tool.after': [
      ...(lessons.length ? (['edit'] as const) : []),
      ...(bigOut ? (['shell', 'read'] as const) : []),
      ...(on('loop-hint') ? (['shell'] as const) : []),
      ...(pace ? (['edit', 'shell'] as const) : []),
      ...userKinds('tool.after'),
    ],
  }

  const runUser = async (event: HookEventName, facts: HookFacts) => {
    const plan = activePlan(c.task)
    const p = plan ? planProgress(c.task, plan) : undefined
    const input: HookInput = {
      ...base,
      event,
      ...(facts.tool
        ? {
            tool: {
              kind: facts.tool.kind,
              name: facts.tool.name,
              input: facts.tool.input,
              ...(facts.tool.panel ? { panel: facts.tool.panel } : {}),
              ...(facts.tool.result ? { result: facts.tool.result } : {}),
            },
          }
        : {}),
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
    for (const h of all.filter((x) => hookApplies(x, input, r))) {
      const res = isPluginHook(h) ? await runPluginHook(h, input, c.cwd) : await runHook(h, input, c.cwd)
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

  const endOff = off.has('turn.beforeEnd')
  const builtinEnd = on('keep-going') && !endOff ? c.call.beforeEnd : undefined
  const userEnd = !endOff && mine('turn.beforeEnd').length > 0
  // 改完没验证：只给对话（有结束前判断的调用），Chat 页一问一答不拦
  const verifyEnd = !endOff && on('verify-before-end') && !!c.call.beforeEnd && !isChatMode(c.task)
  const beforeEnd =
    builtinEnd || userEnd || verifyEnd
      ? async (input: BeforeEndInput): Promise<BeforeEndDecision> => {
          let d: BeforeEndDecision = builtinEnd ? await builtinEnd(input) : { block: false, why: 'builtin-off' }
          if (!d.block && verifyEnd) {
            const asked = unverifiedEdit(c.task)
            if (asked && verified.get(c.task.id) !== asked) {
              verified.set(c.task.id, asked)
              d = {
                block: true,
                why: 'verify',
                reason:
                  '【面板】这次改了文件，之后还没跑过任何检查就要结束：按项目的测试步骤跑一下快速检查（类型检查、相关单测），通过了再结束；确实不用跑（只改了文档、注释）就一句话说明原因。',
              }
              noteBuiltin('verify-before-end', 'turn.beforeEnd', 'block', d.reason!)
            }
          }
          if (!d.block && userEnd) {
            const u = await runUser('turn.beforeEnd', {})
            if (u.block) d = { block: true, reason: u.block, why: 'user-hook' }
          }
          if (d.block && d.reason) {
            c.mark(d.reason)
            // 拦住后 CLI 马上带着说明发下一次请求：首包从这里算（cli-trace），不然只算出零点几秒
            traceCli(c.task.id, c.call.step?.id ?? '', { type: 'sent' })
            if (d.why !== 'user-hook' && d.why !== 'verify')
              noteBuiltin('keep-going', 'turn.beforeEnd', 'block', d.reason)
          }
          return d
        }
      : undefined

  /** 原地打转：同一条 shell 命令连续失败到设置的次数时补一句；CLI 报不出失败（failed 为 undefined）的不算 */
  const loopHint = (facts: HookFacts): string => {
    const tool = facts.tool
    if (!tool || tool.kind !== 'shell' || tool.result?.failed === undefined) return ''
    const key = String(tool.input.command ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!key) return ''
    const mine = fails.get(c.task.id) ?? new Map<string, number>()
    fails.set(c.task.id, mine)
    if (!tool.result.failed) {
      mine.delete(key)
      return ''
    }
    const n = (mine.get(key) ?? 0) + 1
    mine.set(key, n)
    const times = Math.max(1, builtinNumber(data, 'loop-hint', 'times'))
    if (n !== times) return ''
    const text = `【面板】这条命令已经连续失败 ${n} 次了：${key.slice(0, 120)}。先停下来想清楚原因，换个思路（看报错原文、查配置、缩小范围）；确实卡住了就说明卡在哪、需要什么。`
    noteBuiltin('loop-hint', 'tool.after', 'context', text)
    return text
  }

  let bigHints = 0
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
        // 推给模型的教训也算命中（shared/knowledge-hits.ts）
        if (hit.length)
          void recordKnowledgeHits(
            c.project.id,
            'lessons',
            hit.map((l) => l.id),
            c.task.parentTaskId || c.task.id,
          )
        if (hit.length) noteBuiltin('push-lessons', event, 'context', `${r}：${hit.map((l) => l.title).join('、')}`)
        if (hit.length)
          ctx.push(
            `【面板】${r} 有相关的项目教训，照着做：\n${hit.map((l) => `- ${l.title}${l.rule ? `：${l.rule}` : ''}`).join('\n')}`,
          )
      }
      const loop = on('loop-hint') ? loopHint(facts) : ''
      if (loop) ctx.push(loop)
      // 大输出提醒：每次调用最多两次，提醒多了就成了噪音
      const big =
        bigOut && bigHints < 2
          ? bigOutputHint(facts, builtinNumber(data, 'big-output-hint', 'chars'), !!c.call.orch?.canBackground)
          : ''
      if (big) {
        bigHints++
        noteBuiltin('big-output-hint', event, 'context', big)
        taskLog(c.task.id, '大输出提醒', { tool: facts.tool?.name, size: facts.tool?.result?.size })
        ctx.push(big)
      }
      if (pace && facts.tool) {
        const st = paces.get(c.task.id) ?? newPace()
        paces.set(c.task.id, st)
        const text = planPaceHint(
          c.task,
          facts.tool.kind,
          st,
          builtinNumber(data, 'plan-pace', 'calls'),
          builtinNumber(data, 'plan-pace', 'times'),
        )
        if (text) {
          noteBuiltin('plan-pace', event, 'context', text)
          taskLog(c.task.id, '计划没跟上，工具后补了提醒', { calls: st.calls })
          ctx.push(text)
        }
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

  /**
   * 交给面板后台命令（run_background）的命令也过工具前的守卫和用户钩子：以前它们只管 CLI 自己的命令工具，
   * 只读角色、推送授权、危险命令、凭据、测试归属这些规则换成后台命令就全绕过去了。长命令守卫不问（它本来就是让命令来这里），
   * 不看 CLI 支不支持钩子、设置里有没有按 CLI 关掉工具前事件：这是面板自己执行的命令
   */
  const commandGuard = async (command: string): Promise<string> => {
    const facts: HookFacts = {
      tool: { kind: 'shell', name: 'run_background', input: { command }, path: '', paths: [] },
    }
    for (const [id, fn] of guards) {
      if (id === 'long-command-guard') continue
      const deny = fn(guard(id), facts)
      if (!deny) continue
      taskLog(c.task.id, '后台命令被守卫拒绝', { guard: id, command: command.slice(0, 200) })
      noteBuiltin(id, 'tool.before', 'deny', deny)
      return deny
    }
    return mine('tool.before').length ? ((await runUser('tool.before', facts)).deny ?? '') : ''
  }

  /**
   * 插件的改文件类工具（插件接口 3，McpTool.effect = 'edit'）也过工具前的守卫和用户钩子：MCP 调用在 CLI 那边不算改文件，
   * 以前写资产、改蓝图能绕过只读身份、Bug 先诊断和独立分支越界。按「改文件」的事实交给同一套守卫（路径是插件按参数算的 targets）
   */
  const editGuard = async (tool: string, paths: string[], input: Record<string, unknown>): Promise<string> => {
    const facts: HookFacts = { tool: { kind: 'edit', name: tool, input, path: paths[0] ?? '', paths } }
    for (const [id, fn] of guards) {
      const deny = fn(guard(id), facts)
      if (!deny) continue
      taskLog(c.task.id, '插件工具被守卫拒绝', { guard: id, tool, paths: paths.slice(0, 5) })
      noteBuiltin(id, 'tool.before', 'deny', deny)
      return deny
    }
    return mine('tool.before').length ? ((await runUser('tool.before', facts)).deny ?? '') : ''
  }

  // 装到这次调用的 Orchestra 上：run_background 放行前调它（server/background-tools.ts）
  c.call.orch.guardCommand = commandGuard
  // 插件 MCP 会话执行改文件类工具前调它（server/plugins/mcp.ts）
  c.call.orch.guardEdit = editGuard
  return {
    ...(beforeEnd ? { beforeEnd } : {}),
    ...(events.length ? { hookEvents: events, hookTools, onHook } : {}),
  }
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
