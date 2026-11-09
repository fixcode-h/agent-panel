/**
 * 派单：回复里把事情交出去的那几次调用（新开 / 交回子对话、派子任务、后台命令、就地微改动、启动工作流）。
 * 每次派单有一个自己往前走的对象，对象没办完时这一行不收进折叠（设计稿：回复折叠与派单行重设计 §5）；
 * 分诊记录（TaskRoute）也对到具体的那一次派单上，画在同一行里，不再另起一张卡片（§4）
 */
import type { Task, TaskMessage, TaskRoute, TaskStep } from '@shared/schema'
import { childIcon, type ChildEntry } from '@shared/task'
import { bgJobIds } from '@shared/panel-tools'
import { groupTools, panelCallName, panelChildId, toolArgs } from './tasks'
import { toolRole } from './fold-roles'
import { routeAnchors } from './route-anchor'

export type DispatchKind = 'child-new' | 'child-resend' | 'subtask' | 'job' | 'inline-edit' | 'run'

export interface Dispatch {
  /** `消息 id#第几次工具调用`；派出子任务的那条系统消息记 -1 */
  key: string
  msgId: string
  /** 这条消息在对话里的位置（对分诊时按先后找） */
  index: number
  /** 这条消息的第几次工具调用，系统消息为 -1 */
  tool: number
  kind: DispatchKind
  /** 对象：子对话 id、子任务步骤 id、后台命令编号、就地改动的文件 */
  targets: string[]
  /** 调用本身失败了（面板拒绝）：按工具失败处理，收进折叠、折叠行上标红 */
  failed: boolean
  /**
   * 旧记录里同一段话逐个交给了几个子对话（现在面板拒绝这么发）：界面合成一行「发给 n 个子对话」，
   * 不拆成几条派单行，也不跟着子对话的状态留在外面
   */
  grouped?: boolean
}

export const dispatchKey = (msgId: string, tool: number) => `${msgId}#${tool}`

const KIND: Record<string, DispatchKind> = {
  create_conversation: 'child-new',
  start_workflow: 'child-new',
  send_to_conversation: 'child-resend',
  spawn_agents: 'subtask',
  run_background: 'job',
  request_build: 'job',
  begin_inline_edit: 'inline-edit',
  start_plan: 'run',
  run_workflow: 'run',
}

/** 一串消息里的派单，按发生的顺序 */
export function dispatchesOf(msgs: TaskMessage[], offset = 0): Dispatch[] {
  const out: Dispatch[] = []
  msgs.forEach((m, i) => {
    const index = offset + i
    if (m.spawned?.length)
      out.push({
        key: dispatchKey(m.id, -1),
        msgId: m.id,
        index,
        tool: -1,
        kind: 'subtask',
        targets: m.spawned,
        failed: false,
      })
    if (m.role !== 'agent') return
    const grouped = new Set<number>()
    let at = 0
    for (const g of groupTools(m.tools)) {
      if (g.length > 1) for (let j = 0; j < g.length; j++) grouped.add(at + j)
      at += g.length
    }
    m.tools.forEach((x, k) => {
      if (toolRole(x) !== 'dispatch') return
      const name = panelCallName(x)
      const kind = KIND[name]
      if (!kind) return
      // 成功派出的子任务由记着 spawned 的那条系统消息代表（它带着步骤 id）；调用这一行只在失败时算一次派单
      if (name === 'spawn_agents' && !x.failed) return
      const a = toolArgs(x)
      const targets =
        kind === 'child-new' || kind === 'child-resend'
          ? [panelChildId(x)].filter(Boolean)
          : kind === 'job'
            ? bgJobIds(x.output ?? '')
            : kind === 'inline-edit' && Array.isArray(a.files)
              ? a.files.map(String)
              : []
      out.push({
        key: dispatchKey(m.id, k),
        msgId: m.id,
        index,
        tool: k,
        kind,
        targets,
        failed: !!x.failed,
        ...(grouped.has(k) && { grouped: true }),
      })
    })
  })
  return out
}

/** 分诊去向对得上哪几种派单 */
const ROUTE_KINDS: Record<TaskRoute['target'], DispatchKind[]> = {
  child: ['child-new', 'child-resend'],
  resend: ['child-resend', 'child-new'],
  subtask: ['subtask'],
  'inline-edit': ['inline-edit'],
}

/**
 * 每条分诊对到哪一次派单（派单 key → 分诊）。对法：出自的那条用户消息之后、下一条用户消息之前，
 * 去向种类一致、对象（子对话 id、子任务 id）对得上的派单；几次都对得上时取分诊时刻之前最后发出的那次。
 * 对不上的（旧数据、调用失败没有对象）退回原来按消息挂的办法（orphan：消息 id → 分诊）
 */
export function routeDispatches(
  msgs: TaskMessage[],
  routes: TaskRoute[] | undefined,
  ds: Dispatch[],
): { byKey: Map<string, TaskRoute[]>; orphan: Map<string, TaskRoute[]> } {
  const byKey = new Map<string, TaskRoute[]>()
  const left: TaskRoute[] = []
  if (!routes?.length) return { byKey, orphan: new Map() }
  const index = new Map(msgs.map((m, i) => [m.id, i]))
  for (const r of routes) {
    const from = r.messageId ? (index.get(r.messageId) ?? -1) : -1
    // 出自的那条之后又来了一条用户自己发的消息：已经是下一轮了，不再往后找
    let end = msgs.length
    for (let i = from + 1; i < msgs.length; i++)
      if (msgs[i].role === 'user' && !msgs[i].peer) {
        end = i
        break
      }
    const at = Date.parse(r.at)
    const cand = ds.filter(
      (d) =>
        d.index > from &&
        d.index < end &&
        ROUTE_KINDS[r.target].includes(d.kind) &&
        (r.target === 'inline-edit' || d.targets.some((x) => r.refs.includes(x))),
    )
    const before = cand.filter((d) => {
      const t = Date.parse(msgs[d.index].at)
      return !Number.isFinite(at) || !Number.isFinite(t) || t <= at
    })
    const pick = before.at(-1) ?? cand[0]
    if (!pick) {
      left.push(r)
      continue
    }
    const list = byKey.get(pick.key)
    if (list) list.push(r)
    else byKey.set(pick.key, [r])
  }
  return { byKey, orphan: routeAnchors(msgs, left) }
}

/** 改派消息里带上分诊 id：界面按它认出哪条分诊已经改派过 */
export const rerouteTag = (id: string) => `（分诊 ${id}）`

/** 用户点过改派的分诊 id */
export function reroutedIds(msgs: TaskMessage[], routes: TaskRoute[] | undefined) {
  const out = new Set<string>()
  for (const r of routes ?? [])
    if (msgs.some((m) => m.role === 'user' && m.text.includes(rerouteTag(r.id)))) out.add(r.id)
  return out
}

/** 派单对象现在的样子：行尾的状态胶囊照它写，没办完（open）的不收进折叠 */
export type DispatchStatus = 'running' | 'queued' | 'needs' | 'stopped' | 'failed' | 'done' | 'rerouted'

export interface DispatchState {
  status: DispatchStatus
  open: boolean
}

export interface DispatchWorld {
  task: Pick<Task, 'steps' | 'jobs' | 'messages'>
  children: ChildEntry[]
  /** 子对话 id → 最近一次派给它的派单 key：同一个子对话交回几次，只有最近那次跟着它的状态走 */
  latestChild: Map<string, string>
  /** 改派过的分诊 id */
  rerouted: Set<string>
}

/** 子对话 id → 最近一次派给它的派单 */
export function latestChildDispatch(ds: Dispatch[]) {
  const out = new Map<string, string>()
  for (const d of ds)
    if ((d.kind === 'child-new' || d.kind === 'child-resend') && d.targets[0]) out.set(d.targets[0], d.key)
  return out
}

const done: DispatchState = { status: 'done', open: false }

/** 子任务这几步现在的样子：有在跑的就是在跑，其次排队、被打断、失败，全部做完才算办完 */
function stepsState(steps: TaskStep[]): DispatchState {
  const left = steps.filter((s) => s.status !== 'done' && s.status !== 'skipped')
  if (!left.length) return done
  if (left.some((s) => s.status === 'running' && !s.interrupted)) return { status: 'running', open: true }
  if (left.some((s) => s.status === 'pending' && !s.interrupted)) return { status: 'queued', open: true }
  if (left.some((s) => s.interrupted && s.status !== 'failed')) return { status: 'stopped', open: true }
  return { status: 'failed', open: true }
}

/**
 * 一次派单现在办到哪了。「办完」只认正常做完：在跑、排队、等你处理、停下、失败都算没办完，留在折叠外面
 * （停下、失败要人处理，和「报错一律显示给用户」一致）。状态只读现成的单一判定：子对话 childIcon、
 * 子任务步骤状态、后台命令列表，不另算一套
 */
export function dispatchState(d: Dispatch, routes: TaskRoute[] | undefined, w: DispatchWorld): DispatchState {
  if (routes?.some((r) => w.rerouted.has(r.id))) return { status: 'rerouted', open: false }
  if (d.failed) return { status: 'failed', open: false }
  if (d.grouped) return done
  switch (d.kind) {
    case 'child-new':
    case 'child-resend': {
      const id = d.targets[0]
      if (!id || w.latestChild.get(id) !== d.key) return done
      const entry = w.children.find((c) => c.id === id)
      // 不在列表里：归档、删除了，算处理完
      if (!entry) return done
      const icon = childIcon(entry)
      if (icon === 'done') return done
      if (icon === 'failed') return { status: 'failed', open: true }
      if (icon === 'waiting') return { status: 'needs', open: true }
      if (icon === 'running') return { status: 'running', open: true }
      return { status: 'stopped', open: true }
    }
    case 'subtask': {
      const steps = d.targets.map((id) => w.task.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s)
      return steps.length ? stepsState(steps) : done
    }
    case 'job': {
      const jobs = (w.task.jobs ?? []).filter((j) => d.targets.includes(j.id))
      if (!jobs.length) return done
      return { status: jobs.some((j) => j.state === 'running') ? 'running' : 'queued', open: true }
    }
    case 'inline-edit': {
      const after = w.task.messages.slice(d.index + 1)
      const ended = after.some((m) => m.tools.some((x) => panelCallName(x) === 'end_inline_edit'))
      return ended ? done : { status: 'running', open: true }
    }
    default:
      // 工作流运行另有运行区那一行管，派单行不留在外面
      return done
  }
}

/**
 * 这次派单留不留在折叠外面：子对话、子任务做完了也留在原位（用户 2026-11-09 要求「完成也显示在那个地方不折叠」），
 * 行尾的状态胶囊写「已完成」；别的派单（后台命令、就地微改动）没办完才留。调用本身失败的照工具失败收进折叠；
 * 旧记录里同一段话发给几个子对话的合成一行画，不拆出来
 */
export function staysOut(d: Dispatch, isOpen: (d: Dispatch) => boolean) {
  if (d.failed || d.grouped) return false
  return d.kind === 'child-new' || d.kind === 'child-resend' || d.kind === 'subtask' || isOpen(d)
}

/** 一串派单里还没办完的子对话、子任务：最新一轮里它们画在原位，运行区不再重复列（§5.2） */
export function openTargets(ds: Dispatch[], isOpen: (d: Dispatch) => boolean) {
  const out = { children: new Set<string>(), helpers: new Set<string>() }
  for (const d of ds) {
    if (!isOpen(d)) continue
    const set =
      d.kind === 'child-new' || d.kind === 'child-resend'
        ? out.children
        : d.kind === 'subtask'
          ? out.helpers
          : undefined
    for (const x of d.targets) set?.add(x)
  }
  return out
}
