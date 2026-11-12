/**
 * 子对话这会儿在做什么、在等什么、多久前有过输出：父对话的子对话栏和给父对话的对话清单都读这里。
 * 从 task.ts 拆出来（文件行数上限），task.ts 原样转出；和 task.ts 互相引用，只在函数里取它的判定
 */
import type { Task, ToolUse } from '../schema.ts'
import { t, uiLocale } from '../i18n.ts'
import { activePlan, planProgress } from '../plan.ts'
import { confirmWait, confirmWaitText } from './needs.ts'
import { pendingAction } from '../user-action.ts'
import { helperRunning } from '../tasks/helpers.ts'
import { diagnosisPending, runRunning } from '../task.ts'

/** 子对话这会儿在做什么：父对话的子对话栏接在名字后面显示（前五项只有一项有值） */
export interface ChildActivity {
  /** 正在跑的工作流节点 */
  steps?: string[]
  /** 在等的子任务 */
  helpers?: string[]
  /** 正在调用（或刚调用完）的工具 */
  tool?: Pick<ToolUse, 'kind' | 'name' | 'label'>
  /** 正在说的最后一句 */
  text?: string
  /** 还没有输出，在想 */
  thinking?: boolean
  /** 正在做的计划步骤（和上面几项可以同时有值）：父对话不用翻计划窗口也知道做到第几步 */
  plan?: { title: string; child?: string; done: number; total: number }
}

/**
 * 子对话在等什么：不是在跑，但也不是卡住。父对话问「是不是卡住了」时靠它回答，
 * 列表里超时没新输出也先看这一项，能解释的等待不标红
 */
export type ChildWait =
  | { kind: 'answer'; n: number }
  | { kind: 'confirm'; n: number; title?: string; question?: boolean }
  | { kind: 'children'; n: number }
  | { kind: 'background'; n: number }
  | { kind: 'helpers'; list: string[] }
  | { kind: 'workflow' }
  | { kind: 'diagnosis'; version: number; rev: number }
  | { kind: 'action'; title: string }
  | { kind: 'next' }

/** 等待原因的一句话：子对话栏、list_conversations、计划面板都用它 */
export function childWaitText(w: ChildWait | undefined): string {
  switch (w?.kind) {
    case 'answer':
      return t('等用户回答 {n} 个提问', { n: w.n })
    case 'confirm':
    case 'children':
      return confirmWaitText(w)
    case 'background':
      return t('等 {n} 个后台命令', { n: w.n })
    case 'helpers':
      return t('等子任务：{list}', { list: w.list.join(t('、')) })
    case 'workflow':
      return t('等工作流跑完')
    case 'diagnosis':
      return t('等你查看诊断报告第 {n} 版', { n: w.rev })
    case 'action':
      return t('等你操作：{title}', { title: w.title })
    case 'next':
      return t('等下一句')
    default:
      return ''
  }
}

/**
 * 子对话在等什么，按「越需要用户处理越靠前」排：等用户回答、等确认、等后台命令、
 * 等派出的子任务、等工作流运行，最后是这一轮结束后等下一句（进程还活着，cliAlive）。
 * background 由服务端给（后台命令在服务端跑，任务里只有编号），cliAlive 同理
 */
export function childWait(
  tk: Pick<Task, 'status' | 'working' | 'requests' | 'parentAsks' | 'steps'> & {
    runs?: Task['runs']
    bug?: Task['bug']
    userActions?: Task['userActions']
  },
  x: { background?: number; cliAlive?: boolean; childNeeds?: number } = {},
): ChildWait | undefined {
  const asking = tk.parentAsks?.length ?? 0
  if (asking) return { kind: 'answer', n: asking }
  const requests = tk.requests?.length ?? 0
  if (requests) return confirmWait(tk.requests)
  if (diagnosisPending(tk)) {
    const d = tk.bug!.diagnoses!.at(-1)!
    return { kind: 'diagnosis', version: d.version, rev: d.rev ?? d.version }
  }
  const act = pendingAction(tk)
  if (act) return { kind: 'action', title: act.title }
  if (x.childNeeds) return { kind: 'children', n: x.childNeeds }
  if (x.background) return { kind: 'background', n: x.background }
  const helpers = tk.steps.filter(helperRunning).map((s) => s.title)
  if (helpers.length) return { kind: 'helpers', list: helpers }
  if (runRunning(tk)) return { kind: 'workflow' }
  if (!tk.working && x.cliAlive) return { kind: 'next' }
  return undefined
}

/**
 * 子对话这会儿在做什么：在跑的工作流节点、在等的子任务、正在调用的工具，或者正在说的最后一句；
 * 计划没做完时附上正在做的那一步。没在执行时没有
 */
export function childActivity(tk: Pick<Task, 'working' | 'steps' | 'messages' | 'plans'>): ChildActivity | undefined {
  const plan = activePlan(tk)
  const p = plan ? planProgress(tk, plan) : undefined
  const doing = p?.current
    ? { title: p.current.step.title, child: p.current.child?.title, done: p.done, total: p.total }
    : undefined
  if (!tk.working) return doing ? { plan: doing } : undefined
  const running = tk.steps.filter((s) => s.status === 'running' && s.kind !== 'main')
  const nodes = running.filter((s) => !s.parentId).map((s) => s.title)
  if (nodes.length) return { steps: nodes, plan: doing }
  const helpers = running.filter(helperRunning).map((s) => s.title)
  const last = [...tk.messages].reverse().find((m) => m.role === 'agent' && !m.step)
  const tool =
    [...(last?.tools ?? [])].reverse().find((x) => x.running) ?? (last?.text.trim() ? undefined : last?.tools.at(-1))
  if (tool) return { tool: { kind: tool.kind, name: tool.name, label: tool.label.slice(0, 200) }, plan: doing }
  if (helpers.length) return { helpers, plan: doing }
  const line = (last?.text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  if (line) return { text: line.slice(0, 200), plan: doing }
  return { thinking: true, plan: doing }
}

/**
 * 在做什么的一句话：父对话的 list_conversations、计划面板的等待行用它；
 * 界面的子对话栏用自己的富文本（工具名按对话里的说法显示）
 */
export function childActivityText(a: ChildActivity | undefined): string {
  if (!a) return ''
  const doing = a.steps?.length
    ? a.steps.join(t('、'))
    : a.tool
      ? a.tool.label
      : a.helpers?.length
        ? t('等子任务：{list}', { list: a.helpers.join(t('、')) })
        : (a.text ?? (a.thinking ? t('正在思考…') : ''))
  const plan = a.plan
    ? t('计划 {done}/{total} · {step}', {
        done: a.plan.done,
        total: a.plan.total,
        step: a.plan.child || a.plan.title,
      })
    : ''
  return [doing, plan].filter(Boolean).join(' · ')
}

/**
 * 子对话最后有动静的时间：最后一条消息的时间、节点开始/结束时间，和任务更新时间里最晚的那个。
 * 一直在跑但几分钟没有任何新输出的，用这个标出来，父对话不用拿分支时间戳猜
 */
export function childLastActivity(t: Pick<Task, 'messages' | 'steps' | 'updatedAt'>): string {
  let at = t.updatedAt || ''
  const msg = t.messages.at(-1)?.at
  if (msg && msg > at) at = msg
  for (const s of t.steps) {
    if (s.startedAt && s.startedAt > at) at = s.startedAt
    if (s.endedAt && s.endedAt > at) at = s.endedAt
  }
  return at
}

/** 「3 分钟前」这类相对时间：子对话列表、计划面板、给父对话的对话清单都用它 */
export function timeAgo(iso: string, now = Date.now()) {
  if (!iso) return ''
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return ''
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('{n} 天前', { n: Math.floor(s / 86400) })
  return new Date(iso).toLocaleDateString(uiLocale())
}
