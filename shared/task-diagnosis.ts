/**
 * 「为什么停在这里」：会话栏最上面那块「状态」的内容。
 *
 * 面板其实一直知道对话停住的原因（在等哪个子对话、哪条后台命令、哪个提问，计划还剩几步、面板推过没有），
 * 用户以前只看到「等待你的下一条消息」，要翻对话、翻子对话栏才能拼出来。这里把这些事实收成一句标题 + 几行明细，
 * 判定全部复用已有的那几处（convState、childState、childStale、openPlan、stopReasonText），不另写一套。
 */
import { t } from './i18n.ts'
import { activePlan, needsFix, openPlan, openWork, planProgress } from './plan.ts'
import type { Task, TaskMessage } from './schema.ts'
import {
  childActivity,
  childActivityText,
  childAutoAskWaiting,
  childFacts,
  childStale,
  childState,
  childWaitText,
  convActive,
  convState,
  convStateText,
  helperRunning,
  lastFailureNote,
  runRunning,
  stopReasonText,
  timeAgo,
  type ChildEntry,
  type ConvState,
} from './task.ts'

export type DiagTone = 'accent' | 'warning' | 'danger' | 'subtle' | 'success'

export interface DiagItem {
  /** 明细的种类：界面按它选图标 */
  kind: 'child' | 'helper' | 'job' | 'workflow' | 'ask' | 'api' | 'plan' | 'nudge' | 'branch' | 'hint'
  text: string
  /** 第二行的补充（多久没输出、正在做哪一步）；可以为空 */
  detail?: string
  tone: DiagTone
  /** 点了能打开的子对话 */
  taskId?: string
}

export interface Diagnosis {
  state: ConvState
  /** 一句话：现在是什么情况 */
  headline: string
  tone: DiagTone
  items: DiagItem[]
}

type DiagTask = Pick<
  Task,
  | 'status'
  | 'working'
  | 'steps'
  | 'messages'
  | 'plans'
  | 'requests'
  | 'parentAsks'
  | 'resolved'
  | 'stopReason'
  | 'wrapRequest'
  | 'worktree'
  | 'parentTaskId'
  | 'apiWait'
  | 'cliAlive'
  | 'awaitingUser'
> & { runs?: Task['runs']; jobs?: Task['jobs']; childrenWorking?: number; archived?: boolean; deletedAt?: string }

/** 面板推它接着做计划的那条消息（见 server/tasks/children.ts 的 nudgePlan）：开头固定 */
const NUDGE_HEAD = '【面板】你的计划才做了'

/** 最近一次「面板推它接着做」：在最后一条 Agent 回复之后才算还没被回应 */
function lastNudge(messages: TaskMessage[]): { at: string; answered: boolean } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.text.startsWith(NUDGE_HEAD)) {
      const answered = messages.slice(i + 1).some((x) => x.role === 'agent' && (x.text.trim() || x.tools.length))
      return { at: m.at, answered }
    }
  }
  return undefined
}

/**
 * 这个对话为什么是现在这个样子。children 是名下的子对话（/children 的摘要，没有就传空数组），
 * now 可注入（测试用）
 */
export function diagnoseTask(task: DiagTask, children: (ChildEntry & { title: string })[] = [], now = Date.now()) {
  const busyKids = children.filter((c) => convActive(childState(c)))
  // 顶层对话的列表状态（taskState）不看计划；这里要说清「计划没做完就停了」，所以按子对话那套事实算（childFacts），
  // 独立分支没合回只对子对话算
  const state = convState({
    ...childFacts(task, {
      background: task.jobs?.length ?? 0,
      unmerged: !!task.parentTaskId && task.worktree?.state === 'active',
    }),
    children: busyKids.length || (task.childrenWorking ?? 0),
  })
  const items: DiagItem[] = []

  // 等你处理的排最前：不处理它就不会往下走
  const asking = task.parentAsks?.length ?? 0
  if (asking) items.push({ kind: 'ask', text: t('{n} 个提问等你回答', { n: asking }), tone: 'warning' })
  if (task.requests.length)
    items.push({ kind: 'ask', text: t('{n} 项操作等你确认', { n: task.requests.length }), tone: 'warning' })

  if (task.apiWait)
    items.push({
      kind: 'api',
      text: t('排队等 API「{api}」空出并发名额', { api: task.apiWait.api }),
      detail: task.apiWait.ahead ? t('前面还有 {n} 个', { n: task.apiWait.ahead }) : t('下一个就是这里'),
      tone: 'subtle',
    })

  // 在等的子对话：多久没输出按 childStale 标黄 / 标红，面板自动问过的也说清
  for (const c of busyKids) {
    const st = childState(c)
    const level = childStale({ working: c.working, wait: c.waiting, lastActivityAt: c.lastActivityAt }, now)
    const quiet =
      level && c.lastActivityAt
        ? t('已 {n} 分钟没有新输出', { n: Math.max(1, Math.round((now - Date.parse(c.lastActivityAt)) / 60000)) })
        : ''
    const asked = childAutoAskWaiting(c) ? t('已自动询问，等回复') : ''
    const plan = c.plan ? t('计划 {done}/{total}', { done: c.plan.done, total: c.plan.total }) : ''
    items.push({
      kind: 'child',
      text: c.title,
      detail: [convStateText(st), childWaitText(c.waiting), plan, quiet, asked].filter(Boolean).join(' · '),
      tone: level === 'stale' ? 'danger' : level ? 'warning' : st === 'needs' ? 'warning' : 'accent',
      taskId: c.id,
    })
  }

  const helpers = task.steps.filter(helperRunning)
  if (helpers.length)
    items.push({
      kind: 'helper',
      text: t('子任务：{list}', { list: helpers.map((s) => s.title).join(t('、')) }),
      tone: 'accent',
    })
  for (const j of task.jobs ?? [])
    items.push({
      kind: 'job',
      text: t('后台命令：{name}', { name: j.name || j.command }),
      detail:
        j.state === 'queued' ? t('排队中') : j.startedAt ? t('已运行 {ago}', { ago: timeAgo(j.startedAt, now) }) : '',
      tone: 'accent',
    })
  if (runRunning(task)) items.push({ kind: 'workflow', text: t('工作流运行中'), tone: 'accent' })

  // 计划：还剩几步、下一步做什么；面板推过它之后还停着要标出来（ADR 0032）
  const open = openPlan(task)
  const plan = activePlan(task)
  if (open && plan) {
    const left = openWork(task)
    const fix = left.find(needsFix)
    const cur = planProgress(task, plan).current?.step
    const next = fix ?? cur ?? left[0]
    items.push({
      kind: 'plan',
      text: t('计划 {done}/{total}', { done: open.done, total: open.total }),
      detail: next ? (fix ? t('要修：{step}', { step: next.title }) : t('下一步：{step}', { step: next.title })) : '',
      tone: fix ? 'warning' : 'subtle',
    })
    const nudge = !task.working ? lastNudge(task.messages) : undefined
    if (nudge && state !== 'running')
      items.push({
        kind: 'nudge',
        text: nudge.answered ? t('面板推过它接着做，回应后又停下了') : t('面板推过它接着做，还没有回应'),
        detail: timeAgo(nudge.at, now),
        tone: 'warning',
      })
  }

  if (task.parentTaskId && task.worktree?.state === 'active' && !task.wrapRequest && state === 'unfinished')
    items.push({ kind: 'branch', text: t('独立分支里的改动还没合回父对话'), tone: 'warning' })

  const { headline, tone } = headlineOf(task, state)
  // 停住了、用户能做什么：一句提示，放最后
  const hint = hintOf(task, state)
  if (hint) items.push({ kind: 'hint', text: hint, tone: 'subtle' })
  return { state, headline, tone, items } satisfies Diagnosis
}

function headlineOf(task: DiagTask, state: ConvState): { headline: string; tone: DiagTone } {
  switch (state) {
    case 'running': {
      const doing = childActivityText(childActivity(task))
      return { headline: doing ? t('正在执行：{doing}', { doing }) : t('正在执行'), tone: 'accent' }
    }
    case 'waiting':
      return { headline: t('这一轮说完了，在等结果推回来'), tone: 'accent' }
    case 'needs':
      return { headline: t('在等你处理'), tone: 'warning' }
    case 'failed': {
      const why = lastFailureNote(task.messages)
      return { headline: why ? t('这一轮失败了：{why}', { why }) : t('这一轮失败了'), tone: 'danger' }
    }
    case 'stopped':
      return { headline: t('已中断：{why}', { why: stopReasonText(task.stopReason) }), tone: 'subtle' }
    case 'wrapup':
      return { headline: t('只剩合回，在等父对话收尾'), tone: 'success' }
    case 'unfinished':
      return openPlan(task)
        ? { headline: t('这一轮结束了，但计划还没做完'), tone: 'warning' }
        : { headline: t('这一轮结束了，改动还没合回'), tone: 'warning' }
    default:
      if (task.resolved) return { headline: t('已完成'), tone: 'success' }
      return task.cliAlive && task.awaitingUser
        ? { headline: t('这一轮答完了，在等你的下一句'), tone: 'success' }
        : { headline: t('这一轮答完了'), tone: 'success' }
  }
}

function hintOf(task: DiagTask, state: ConvState): string {
  if (state === 'stopped' || state === 'failed') return t('发消息或点「继续执行」接着做')
  if (state === 'unfinished' && !task.parentTaskId) return t('发消息告诉它下一步，或者让它接着做计划')
  if (state === 'unfinished') return t('父对话会收到状态；也可以直接在这里发消息让它接着做')
  return ''
}
