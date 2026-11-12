/**
 * 对话状态的收口：「这条对话已经没人在做了」落成已停止的唯一写法，和找出「记录说在做、实际没人做」的矛盾。
 *
 * 状态的读法（convState）早就只有一处，出问题的一直是写法：启动迁移、页面回收、关闭 Agent 各写了一份
 * 「落成已停止」，字段漏一个（轮次、步骤、等待时长、工作流运行）界面就画成还在跑；哪条路径忘了落状态，
 * 对话就一直转圈、没有「继续执行」入口（docs/modules/server/bugs/ 里一半是这一类）。
 * 这里收成一个纯函数，调用方只决定「什么时候收、原因是什么」；另外由 server/tasks/state-sweep.ts
 * 定时找出没人收的矛盾，按同一个写法收口并告诉用户（见 ADR 0033）。
 */
import type { StopReason, Task, TaskMessage } from '../schema.ts'
import { endRun as endPlanRun } from '../plan.ts'
import { t } from '../i18n.ts'
import { diagnosisPending, idleWaitDuration, stopReasonText, waitDuration } from '../task.ts'
import { pauseUnit } from '../run/stops.ts'

/**
 * 落成已停止：结掉还在跑的轮次、步骤（记为被打断，继续执行时续接它的会话）、工作流运行和各段等待时长。
 * 结算的基准是最后一次落盘的时间（`updatedAt`），不把「发现它停了的这一刻」算进这一轮的用时。
 * 不改 `messages`、`updatedAt`：要不要加一句说明、列表时间动不动由调用方决定。
 */
export function settleStopped(tk: Task, reason: StopReason): Task {
  const at = Date.parse(tk.updatedAt)
  const runs = (tk.runs ?? []).map((r) => ({ ...r }))
  const next: Task = {
    ...tk,
    runs,
    plans: tk.plans ? structuredClone(tk.plans) : tk.plans,
    status: 'stopped',
    stopReason: reason,
    requests: [],
    apiWait: undefined,
    working: false,
    awaitingUser: false,
    prewarming: false,
    runMs: (tk.runMs ?? 0) + (tk.runStartedAt ? Math.max(0, at - Date.parse(tk.runStartedAt)) : 0),
    runStartedAt: '',
    waitMs: waitDuration(tk, at),
    waitStartedAt: '',
    // 「等下一句」和等你处理一样结到最后一次落盘：留着 idleWaitAt，继续执行时会从很久以前接着算
    idleWaitMs: idleWaitDuration(tk, at),
    idleWaitAt: '',
    turns: (tk.turns ?? []).map((x) =>
      x.status === 'running' ? { ...x, status: 'stopped' as const, endedAt: tk.updatedAt } : x,
    ),
    // 还在跑的步骤暂停（被打断，继续执行时续接它的会话），和引擎收尾同一个写法（pauseUnit，ADR 0042）；
    // 排队等 API 名额的标记一起清掉：已经没人在排了，不清的话重启后还显示在排队
    steps: tk.steps.map((s) => {
      const w = { ...s, waitMs: waitDuration(s, at), waitStartedAt: '', apiWait: undefined }
      if (s.status === 'running') pauseUnit(w, at)
      return w
    }),
  }
  // 还标着「运行中」的工作流运行：已经没人在跑它了，计划里绑着它的那一步按「工作流没走完」收口；
  // 不然对话一直显示「等工作流跑完」，继续执行也等不到它
  for (const r of runs)
    if (r.status === 'running') {
      r.status = 'stopped'
      r.endedAt = tk.updatedAt
      endPlanRun(next, r.id, false, stopReasonText(reason))
    }
  return next
}

/**
 * Bug 诊断报告还在等用户确认，CLI 也没在答这一轮（ADR 0045）：这一步等的是用户，不靠 CLI 进程。
 * 面板退出、CLI 回收、定时核对都不该把它落成「已中断」，继续执行也不该拉起 CLI 让它自己往下跑（用户 2026-11-04 要求）
 */
export const diagnosisWaiting = (tk: Pick<Task, 'bug' | 'working'>) => diagnosisPending(tk) && !tk.working

/**
 * 回到「等你确认诊断报告」：轮次、步骤、等待时长按停下结算（进程已经没了），但不记成已停止——
 * convState 按报告把它算在运行，弹窗和「查看报告」照常在；用户确认或提意见后发的消息再拉起 CLI。
 * 用户停止、面板重启打断的这一步，继续执行时都走这里，不另开一轮
 */
export function rewaitDiagnosis(tk: Task): Task {
  return { ...settleStopped(tk, 'restart'), status: 'done', stopReason: undefined }
}

/**
 * 收口时作废的提问 / 确认：回答的回调跟着 CLI 进程没了，留着也答不上；但卡片没了要告诉用户为什么。
 * 工作流节点的确认（confirm）不算：继续执行时会重新确认。调用方把它拼在收口那句说明后面，没有就是空串
 */
export function droppedAsksNote(tk: Pick<Task, 'requests'>): string {
  const gone = tk.requests.filter((x) => x.kind !== 'confirm')
  if (!gone.length) return ''
  const list =
    gone
      .slice(0, 3)
      .map((x) => t('「{name}」', { name: x.title }))
      .join(t('、')) + (gone.length > 3 ? t(' 等 {n} 项', { n: gone.length }) : '')
  return t('中断时还有没处理的提问 / 确认：{list}，已经作废；继续执行后 AI 需要的话会重新问。', { list })
}

/**
 * CLI 进程结束时这个进程问的、还没回答的请求（ids）作废：从 requests 去掉，并写一句说明（面板优雅重启、
 * 超时、崩溃都走这里）。用户自己关掉提问、停止对话走 dropRequests，到这里已经清空，不会重复说。返回写没写
 */
export function dropAsked(tk: Task, ids: string[], msg: Pick<TaskMessage, 'id' | 'agentId' | 'step'>) {
  const text = droppedAsksNote({ requests: tk.requests.filter((x) => ids.includes(x.id)) })
  tk.requests = tk.requests.filter((x) => !ids.includes(x.id))
  if (text) tk.messages.push({ ...msg, role: 'system', text, tools: [], transient: true, at: new Date().toISOString() })
  return !!text
}

/**
 * 记录和实际对不上的地方。只列面板自己能确定的两种，模型、计划的事不在这里判：
 * - `orphan`：记录说这一轮在做（running / working / 预热 / 工作流运行中），面板里却没有它的执行位、
 *   不在启动队列、也没有后台命令会把结果推回来——没人会再改它，界面会一直转圈；
 * - `merging`：子对话的收尾请求停在「合并中」，面板里却没有在合它——finish_child 和 submit_merge 都按它拒绝，父子两边卡住。
 */
export type StateBreak = 'orphan' | 'merging'

/** 判定要的现场：只有服务端知道 */
export interface StateLive {
  /** 有执行位（live 里有它） */
  live: boolean
  /** 正在启动、还没取到执行位 */
  queued: boolean
  /** 还在跑、排队的后台命令数 */
  jobs: number
  /** 面板正在合并它的分支 */
  merging: boolean
}

export function stateBreaks(
  tk: Pick<Task, 'status' | 'working' | 'prewarming' | 'deletedAt' | 'wrapRequest'> & { runs?: Task['runs'] },
  x: StateLive,
): StateBreak[] {
  const out: StateBreak[] = []
  if (tk.deletedAt) return out
  const claims =
    tk.status === 'running' ||
    tk.working === true ||
    tk.prewarming === true ||
    !!tk.runs?.some((r) => r.status === 'running')
  if (claims && !x.live && !x.queued && !x.jobs) out.push('orphan')
  if (tk.wrapRequest?.state === 'merging' && !x.merging) out.push('merging')
  return out
}
