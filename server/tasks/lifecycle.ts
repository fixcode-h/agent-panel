import { readFile } from 'node:fs/promises'
import type { Task, TaskStep } from '../../shared/schema.ts'
import { activePlan, openWork, planProgress } from '../../shared/plan.ts'
import { planProgressKey, shortKey } from '../../shared/drive.ts'
import { panelTrail } from '../../shared/end-turn.ts'
import { subtreeTaskIds } from '../../shared/run-usage.ts'
import { taskState, wrapUpPending } from '../../shared/task.ts'
import {
  countEvents,
  lastExit,
  parseLogLine,
  verdictOf,
  type LifeFacts,
  type LifeNode,
  type LifeProcess,
  type LifeReport,
  type LogLine,
} from '../../shared/lifecycle.ts'
import { cliTrace } from '../exec/cli-trace.ts'
import { stalledTurn } from '../exec/stall-watch.ts'
import { heldCount } from '../exec/delivery.ts'
import { trackedClis } from '../exec/orphans.ts'
import { taskCliAlive } from '../exec/process.ts'
import { commandSummary, ownedEntries, processSnapshot } from '../exec/proc-stats.ts'
import { isViewing, isWatched } from '../presence.ts'
import { getSettings } from '../settings.ts'
import { taskLogPath } from '../task-log.ts'
import { currentVersion } from '../update.ts'
import type { TasksScope } from './scope.ts'
import { awaitedJob } from '../background.ts'

/*
 * 状态诊断的事实收集：一棵对话树（对话、子对话、子任务、工作流节点）每个节点的现场快照、落盘状态、
 * 模型请求轨迹、进程、最近的日志，交给 shared/lifecycle.ts 下结论。
 * 生成的报告就是诊断文件的内容：用户复现问题后复制给开发，按它就能定位是网关、CLI 还是面板的问题。
 */

/** 诊断文件的格式标记：以后改结构时加版本，读的人按它认 */
export const LIFECYCLE_FORMAT = 'agent-panel-lifecycle/1'

/** 每个节点在弹窗里带的日志行数；诊断文件里带完整日志（有上限） */
const VIEW_LOG_LINES = 200
/** 诊断文件里每个对话日志的上限：超出的只留最后这么多 */
const FILE_LOG_BYTES = 1_000_000

/** 读一个对话的日志：full 时给完整内容（有上限），否则只给最后几行 */
async function readLog(taskId: string, full: boolean) {
  const file = taskLogPath(taskId)
  if (!file) return { lines: [] as string[], parsed: [] as LogLine[] }
  const text = await readFile(file, 'utf8').catch(() => '')
  const cut = full && text.length > FILE_LOG_BYTES ? text.slice(-FILE_LOG_BYTES) : text
  const all = cut.split('\n').filter(Boolean)
  const parsed = all.map(parseLogLine).filter((x): x is LogLine => !!x)
  return { lines: full ? all : all.slice(-VIEW_LOG_LINES), parsed }
}

/** 诊断里的计划事实：推进按指纹计数，这里写同一份短指纹，对得上就知道是不是这一个进度推满了 */
function planFacts(tk: Task, plan: NonNullable<ReturnType<typeof activePlan>>) {
  const p = planProgress(tk, plan)
  return {
    title: plan.title,
    done: p.done,
    total: p.total,
    waiting: p.waiting,
    open: openWork(tk).length,
    key: shortKey(planProgressKey(plan)),
  }
}

/** 这一步（或对话自己这一轮，step 为空）正在跑的工具 */
/** runner 已把这一轮（子任务按步骤）标成卡住：诊断直接认，不再自己按秒数另算一遍 */
function stalledFacts(id: string, step = '') {
  const st = stalledTurn(id, step)
  return st ? { stalled: { since: st.since } } : {}
}

function runningTool(tk: Task, step = '') {
  for (let i = tk.messages.length - 1; i >= 0 && i >= tk.messages.length - 6; i--) {
    const m = tk.messages[i]
    if ((m.step || '') !== step) continue
    for (let j = m.tools.length - 1; j >= 0; j--) {
      const x = m.tools[j]
      if (x.running) return [x.name, x.label].filter(Boolean).join(' · ')
    }
  }
  return undefined
}

const stepKind = (s: TaskStep): LifeNode['kind'] => (s.slot === 'sub' ? 'helper' : 'node')

/**
 * 收集一棵对话树的诊断报告。full：诊断文件用，日志带完整内容；弹窗只带最近的几行
 */
export async function lifecycleReport(sc: TasksScope, rootId: string, full = false): Promise<LifeReport | null> {
  const metas = await sc.store.list()
  const ids = subtreeTaskIds(metas, rootId)
  if (!ids.size) return null
  const now = Date.now()
  const procs = ownedEntries(trackedClis(), ids)
  const map = await processSnapshot().catch(() => null)
  const procOf = (taskId: string, step = ''): LifeProcess[] =>
    procs
      .filter((e) => e.owner?.taskId === taskId && (e.owner.step ?? '') === step && (!map || map.has(e.pid)))
      .map((e) => ({
        pid: e.pid,
        startedAt: map?.get(e.pid)?.startedAt ?? e.startedAt ?? null,
        rss: map?.get(e.pid)?.rss ?? null,
        command: commandSummary(e.argv),
      }))
  const tasks = new Map<string, Task>()
  for (const id of ids) {
    const tk = sc.live.get(id)?.task ?? (await sc.store.get(id))
    if (tk) tasks.set(id, tk)
  }
  const nodes: LifeNode[] = []
  // 父对话在前、子对话在后（按树的层级），同一层按创建时间
  const depth = (id: string) => {
    let d = 0
    for (let p = tasks.get(id)?.parentTaskId; p && d < 64; p = tasks.get(p)?.parentTaskId) d++
    return d
  }
  const order = [...tasks.keys()].sort(
    (a, b) => depth(a) - depth(b) || (tasks.get(a)!.createdAt || '').localeCompare(tasks.get(b)!.createdAt || ''),
  )
  // 诊断文件里带上和进程存活有关的几项设置
  const st = await getSettings()
  for (const id of order) {
    const tk = tasks.get(id)!
    const e = sc.live.get(id)
    const { lines, parsed } = await readLog(id, full)
    const plan = activePlan(tk)
    const waitsOn = (plan?.steps ?? [])
      .flatMap((s) => [s, ...(s.children ?? [])])
      .filter((s) => s.status === 'waiting' || s.status === 'running')
      .flatMap((s) => s.waits ?? [])
      .filter((w) => w.kind === 'child' && w.state === 'waiting')
      .map((w) => {
        const kid = tasks.get(w.ref)
        const wrapAt = kid && wrapUpPending([kid]).length ? kid.wrapRequest!.at : undefined
        return {
          id: w.ref,
          title: kid?.title ?? w.label ?? w.ref,
          state: kid ? taskState(kid) : ('done' as const),
          ...(wrapAt && { wrapAt }),
        }
      })
    const helpers = tk.steps.filter((s) => s.slot === 'sub' && (s.status === 'running' || s.status === 'pending'))
    const nudged = sc.nudgeState(id)
    const facts: LifeFacts = {
      kind: 'conversation',
      status: tk.status,
      stopReason: tk.stopReason,
      state: taskState(tk),
      working: !!tk.working,
      awaitingUser: !!tk.awaitingUser,
      resolved: tk.resolved === true,
      apiWait: !!tk.apiWait,
      live: e ? { stop: e.stop, stopReason: e.stopReason, stopAt: e.stopAt, prewarming: !!tk.prewarming } : undefined,
      held: heldCount(id),
      cliAlive: taskCliAlive(id),
      runningTool: runningTool(tk),
      helpers: helpers.length,
      jobs: sc.background.list(id).filter(awaitedJob).length,
      waitsOn,
      trace: cliTrace(id),
      exit: lastExit(parsed),
      ...(plan && { plan: planFacts(tk, plan) }),
      ...(nudged && { nudge: { key: shortKey(nudged.key), n: nudged.n } }),
      ...stalledFacts(id),
    }
    const agent = tk.usage.agents[tk.agentId]
    nodes.push({
      id,
      parentId: tk.parentTaskId && tasks.has(tk.parentTaskId) ? tk.parentTaskId : undefined,
      taskId: id,
      title: tk.title,
      kind: 'conversation',
      cli: tk.sessionCli || undefined,
      model: agent?.model || undefined,
      session: tk.sessions[tk.agentId] || undefined,
      viewer: { viewing: isViewing(id), watched: isWatched(id) },
      facts,
      verdict: verdictOf(facts, now),
      processes: procOf(id),
      counts: countEvents(parsed),
      trail: panelTrail(tk),
      log: lines,
    })
    // 子任务、工作流节点：挂在派它的那一步（或对话本身）下面
    const stepIds = new Set(tk.steps.map((s) => s.id))
    for (const s of tk.steps) {
      if (!s.agentId && s.slot !== 'sub') continue
      const sf: LifeFacts = {
        kind: 'helper',
        status:
          s.status === 'running' || s.status === 'pending'
            ? 'running'
            : s.status === 'failed'
              ? 'failed'
              : s.status === 'skipped'
                ? 'stopped'
                : 'done',
        working: s.status === 'running',
        awaitingUser: false,
        apiWait: !!s.apiWait,
        interrupted: !!s.interrupted,
        // 子任务跑在对话这一份执行里：对话的执行位就是它的执行位
        live: e && s.status === 'running' ? { stop: e.stop, stopReason: e.stopReason, stopAt: e.stopAt } : undefined,
        held: 0,
        cliAlive: procOf(id, s.id).length > 0,
        runningTool: runningTool(tk, s.id),
        helpers: 0,
        jobs: 0,
        waitsOn: [],
        trace: cliTrace(id, s.id),
        exit: lastExit(parsed, s.id),
        ...stalledFacts(id, s.id),
      }
      nodes.push({
        id: `${id}#${s.id}`,
        parentId: s.parentId && stepIds.has(s.parentId) ? `${id}#${s.parentId}` : id,
        taskId: id,
        stepId: s.id,
        title: s.title,
        kind: stepKind(s),
        session: s.session || undefined,
        reruns: s.reruns || undefined,
        startedAt: s.startedAt || undefined,
        endedAt: s.endedAt || undefined,
        facts: sf,
        verdict: verdictOf(sf, now),
        processes: procOf(id, s.id),
        counts: countEvents(parsed, s.id),
        log: lines.filter((l) => l.includes(`step=${s.id}`)).slice(-VIEW_LOG_LINES),
      })
    }
  }
  return {
    format: LIFECYCLE_FORMAT,
    generatedAt: new Date(now).toISOString(),
    panel: { version: currentVersion(), platform: process.platform, node: process.version, pid: process.pid },
    // 只带和进程存活有关的设置：不带账号、API、代理这些（可能有密钥）
    settings: {
      stepTimeoutMinutes: st.stepTimeoutMinutes,
      idleTimeoutMinutes: st.idleTimeoutMinutes,
      childIdleAskMinutes: st.childIdleAskMinutes,
      presenceGraceMinutes: st.presenceGraceMinutes,
      reclaimIdleCli: st.reclaimIdleCli,
      childDoneKeepMinutes: st.childDoneKeepMinutes,
      backgroundLimit: st.backgroundLimit,
    },
    rootId,
    nodes,
  }
}

/**
 * 写进诊断文件前去掉可能的密钥：命令行、日志里偶尔会带上 key / token。
 * 只认常见的形态（sk-…、Bearer …、key=…），宁可多遮
 */
export function redact(text: string) {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-****')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1****')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',]{6,}/gi, '$1****')
}
