/**
 * 子对话一行的展示：悬浮层列表和对话消息流里的运行区读同一份函数。
 * 标题以外的状态标签、计划进度、「正在做什么 / 在等什么」都在这里，两处不再各写一套。
 * 判定本身只在 shared/task.ts（childIcon / childState）：这里只把判定变成文字和样式。
 */
import { t } from '@shared/i18n'
import {
  childIcon,
  childStale,
  childState,
  childWaitText,
  convStateText,
  stopReasonText,
  type ChildActivity,
  type ChildEntry,
} from '@shared/task'
import { plainLine, toolVerb, toolView } from '@/lib/tasks'

/** 父对话里的子对话入口：/children 返回的完整摘要（字段和正式后端一致，演示后端也要补齐） */
export interface ChildSummary extends ChildEntry {
  /** 最近的结果：没在跑时行下面的说明 */
  summary: string
  updatedAt: string
  /** 在独立 worktree 里改时的分支 */
  branch?: string
  /** 正在执行时这会儿在做什么 */
  activity?: ChildActivity
}

/** 子对话那一行下面的说明：执行中写正在做什么，其余写它在等什么或最近结果 */
export function childNote(c: ChildSummary, running: boolean) {
  const doing = activityText(c.activity)
  const plan = c.plan?.step || c.plan?.child
  // 在等后台命令 / 子任务 / 工作流时 activity 是空的：补上在等什么，不然那一行只剩个状态标签
  if (running) return [doing, childWaitText(c.waiting), plan].filter(Boolean).join(' · ')
  return childWaitText(c.waiting) || c.summary
}

/**
 * 执行中但是很久没有新输出：标黄 / 标红，父对话不用拿分支时间戳猜它是不是卡住了。
 * 等后台命令、等用户这类能解释的等待不算（见 shared/task.ts 的 childStale）
 */
export function staleLine(c: ChildSummary) {
  const level = childStale({ working: c.working, wait: c.waiting, lastActivityAt: c.lastActivityAt })
  if (!level || !c.lastActivityAt) return undefined
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(c.lastActivityAt)) / 60000))
  return { text: t('已 {n} 分钟没有新输出', { n: mins }), cls: level === 'stale' ? 'text-danger' : 'text-warning' }
}

/** 子对话这会儿在做什么，一句话：跑的节点、等的子任务、正在用的工具或正在说的话 */
export function activityText(a: ChildActivity | undefined) {
  if (!a) return ''
  if (a.steps?.length) return a.steps.join(t('、'))
  if (a.tool) {
    // 面板工具、MCP 工具按对话里显示的说法（开独立分支 xxx），不是「MCP panel-xxxx · begin_edit」
    const v = toolView({ ...a.tool, detail: '' })?.tool ?? { ...a.tool, detail: '' }
    return `${toolVerb(v)} ${v.label}`.trim()
  }
  if (a.helpers?.length) return t('等待子任务：{list}', { list: a.helpers.join(t('、')) })
  if (a.text) return plainLine(a.text)
  return t('正在思考…')
}

/** 标签的语气：对应下面的样式表，悬浮层和运行区用同一套 */
export type ChildLabelTone = 'success' | 'warning' | 'accent' | 'subtle' | 'plain'

export interface ChildLabel {
  text: string
  tone: ChildLabelTone
  /** 已解决带一个对勾（和图标、分组同一处判定） */
  icon?: 'check'
}

/**
 * 一行上的状态标签，顺序固定：已关闭 → 已解决 → 等你选择 → 计划 n/m → 执行中 / 等结果 / 待收尾 →
 * 停下的原因。同一行只说一件事，全部从 childIcon / childState 派生，
 * 所以不会出现「已解决」和「执行中」同屏（以前徽标按 resolved/asking/plan 各算一套就是这么来的）。
 */
export function childLabels(c: ChildSummary): ChildLabel[] {
  const icon = childIcon(c)
  const state = childState(c)
  const out: ChildLabel[] = []
  if (!c.cliAlive) out.push({ text: t('已关闭'), tone: 'plain' })
  if (c.resolved && icon === 'done') out.push({ text: t('已解决'), tone: 'success', icon: 'check' })
  if (icon === 'waiting') out.push({ text: t('等你选择'), tone: 'warning' })
  if (icon === 'running' && c.plan)
    out.push({ text: t('计划 {done}/{total}', { done: c.plan.done, total: c.plan.total }), tone: 'warning' })
  if (icon === 'running') out.push({ text: convStateText(state), tone: state === 'wrapup' ? 'success' : 'accent' })
  // 停下也说清是谁结束的：只有用户按的暂停才是「已暂停」（见 stopReasonText）
  if (icon === 'stopped' || icon === 'idle') out.push({ text: stopReasonText(c.stopReason), tone: 'subtle' })
  return out
}

/** 标签样式：小胶囊带底色的是「状态」，纯文字是「说明」，和列表里的层级一致 */
export const childLabelClass: Record<ChildLabelTone, string> = {
  success: 'flex shrink-0 items-center gap-0.5 rounded-full bg-success/12 px-1.5 text-[0.6875rem] text-success',
  warning: 'shrink-0 rounded-full bg-warning/15 px-1.5 text-[0.6875rem] text-warning',
  accent: 'shrink-0 text-[0.6875rem] text-accent',
  subtle: 'shrink-0 text-[0.6875rem] text-subtle',
  plain: 'shrink-0 rounded-full bg-field px-1.5 text-[0.6875rem] text-subtle',
}
