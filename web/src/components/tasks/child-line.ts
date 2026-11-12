/**
 * 子对话一行的展示：悬浮层列表和对话消息流里的运行区读同一份函数。
 * 标题以外的状态标签、计划进度、「正在做什么 / 在等什么」都在这里，两处不再各写一套。
 * 判定本身只在 shared/task.ts（childIcon / childState）：这里只把判定变成文字和样式。
 */
import { t } from '@shared/i18n'
import {
  resumable,
  childAutoAskWaiting,
  childIcon,
  childStale,
  childState,
  childWaitText,
  convStateText,
  sortChildren,
  stopReasonText,
  visibleChildren,
  type ChildActivity,
  type ChildEntry,
} from '@shared/task'
import type { ChildRequest } from '@shared/children/needs'
import { childWord } from '@shared/task-word'
import type { LastTool } from '@shared/children/doing'
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
  /** 第一条待确认的请求：父对话页直接写出确认什么、给「允许 / 拒绝」（见 ChildRequestBar） */
  request?: ChildRequest
  /** 最后一次工具调用（shared/children/doing.ts）：行上写「计划这一步 · 改 store.ts」（分析稿 U5） */
  lastTool?: LastTool
  /** Bug 走到五步里的第几步（0–4，5 是都走完了）：行上画五个小点（分析稿 U8） */
  bugStep?: number
}

/**
 * 子对话那一行下面的说明：执行中写正在做什么，其余写它在等什么或最近结果。
 * 执行中按「计划这一步 · 在做的事」写（分析稿 U5）：在做的事优先是跑着的工作流节点、在等的子任务，
 * 其次是正在调用或最后一次的工具调用（改 store.ts、运行命令 npm test）；回复开头截的一段没信息量，
 * 只在既没有计划也没有工具调用时才回退到它（以前的样子）
 */
export function childNote(c: ChildSummary, running: boolean) {
  const plan = c.plan?.step || c.plan?.child
  const wait = childWaitText(c.waiting)
  if (running) {
    const a = c.activity
    const busy = a?.steps?.length || a?.helpers?.length ? activityText(a) : toolLine(a?.tool ?? c.lastTool)
    const doing = busy || (a?.thinking && plan ? t('正在思考…') : '')
    if (plan || busy) return [plan, doing, wait].filter(Boolean).join(' · ')
    // 在等后台命令 / 子任务 / 工作流时 activity 是空的：补上在等什么，不然那一行只剩个状态标签
    return [activityText(a), wait].filter(Boolean).join(' · ')
  }
  return wait || c.summary
}

/** 一次工具调用的短说法：动作 + 对象，文件只写文件名（行很窄，整条路径会把文件名挤没） */
function toolLine(tool: LastTool | undefined) {
  if (!tool) return ''
  // 面板工具、MCP 工具按对话里显示的说法（开独立分支 xxx），不是「MCP panel-xxxx · begin_edit」
  const v = toolView({ ...tool, detail: '' })?.tool ?? { ...tool, detail: '' }
  const label = v.kind === 'edit' || v.kind === 'read' ? (v.label.split(/[\\/]/).pop() ?? v.label) : v.label
  return `${toolVerb(v)} ${label}`.trim()
}

/**
 * 执行中但是很久没有新输出：标黄 / 标红，父对话不用拿分支时间戳猜它是不是卡住了。
 * 等后台命令、等用户这类能解释的等待不算（见 shared/task.ts 的 childStale）
 */
export function staleLine(c: ChildSummary) {
  const level = childStale({ working: c.working, wait: c.waiting, lastActivityAt: c.lastActivityAt })
  // 面板已经自动问过、还没有回复：说清在等它回；静默太久（红色）时仍按可能卡住提醒，
  // 不能让「等回复」把红色提示顶掉（见 shared/task.ts 的 childIdleAsk）
  if (childAutoAskWaiting(c)) {
    if (level === 'stale') return { text: t('已自动询问，仍没有新输出'), cls: 'text-danger' }
    return { text: t('已自动询问，等回复'), cls: 'text-accent-text' }
  }
  if (!level || !c.lastActivityAt) return undefined
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(c.lastActivityAt)) / 60000))
  return { text: t('已 {n} 分钟没有新输出', { n: mins }), cls: level === 'stale' ? 'text-danger' : 'text-warning' }
}

/** 子对话这会儿在做什么，一句话：跑的节点、等的子任务、正在用的工具或正在说的话 */
export function activityText(a: ChildActivity | undefined) {
  if (!a) return ''
  if (a.steps?.length) return a.steps.join(t('、'))
  if (a.tool) return toolLine(a.tool)
  if (a.helpers?.length) return t('等待子任务：{list}', { list: a.helpers.join(t('、')) })
  if (a.text) return plainLine(a.text)
  // 只有服务端说「还没有输出、在想」（thinking，只在 working 时给）才写正在思考。
  // 一轮结束后 activity 只剩计划进度（见 shared/task.ts 的 childActivity），以前落到这里也写「正在思考…」，
  // 和「等下一句」同屏、子对话明明空闲了十几分钟还像在跑（实测报告问题 12）
  return a.thinking ? t('正在思考…') : ''
}

/**
 * 子对话停下了、独立分支里还有没提交的改动：行上写清几个文件（目录较长，放在 title 里），
 * 「能不能一键继续」只看 resumable（和服务端 resume 的准入条件同一处）。
 * 不自动提交、不清理目录：那是用户的改动，只把事实说清
 */
export function childDirty(c: ChildSummary) {
  if (!c.dirty || !resumable(c.status)) return undefined
  return { text: t('{n} 个文件未提交', { n: c.dirty }), dir: c.dir || '' }
}

/**
 * 标签的语气：对应下面的样式表，悬浮层和运行区用同一套
 */
export type ChildLabelTone = 'success' | 'warning' | 'accent' | 'subtle' | 'plain'

export interface ChildLabel {
  text: string
  tone: ChildLabelTone
  /** 已解决带一个对勾（和图标、分组同一处判定） */
  icon?: 'check'
  /** Bug 的标签后面画五个小点（分析稿 U8，见 BugStepDots）：值是走到第几步 */
  dots?: number
}

/**
 * 进程回收（cliAlive 为假）时这一行怎么说，一处定完，标签和悬停提示都读它：
 * - closed：这一轮真的结束了（childIcon 是 done），本来就已经没事可做，说「已关闭」；
 * - hint：对话还在跑 / 还在等你处理（running、waiting），或者被页面切走、闲置、重启顺带停下（idle）：
 *   进程都没了，行上写了停下原因，这句补的是「继续还能不能接着做」——一排静止的卡片如果只剩
 *   「页面切走后结束」，用户看不出继续能不能恢复（用户报的现象：很多子对话没有拉起）；
 * - ''：用户自己按的暂停（stopped，说了「已暂停」）、失败（行首图标就是失败，不再提进程）以及进程还活着。
 * 不分开写的理由：以前「已关闭」按 cliAlive、「执行中」按 childIcon 各算一套，两套一碰就出现
 * 「已关闭 + 计划 13/14 + 等结果」同屏（用户报的问题）。合成一次判定，以后加图标只改这一处。
 */
function convGone(c: ChildSummary): 'closed' | 'hint' | '' {
  if (c.cliAlive) return ''
  switch (childIcon(c)) {
    case 'done':
      return 'closed'
    case 'running':
    case 'waiting':
    case 'idle':
      return 'hint'
    default:
      return ''
  }
}

/**
 * 一行上的状态标签，顺序固定：已关闭 → 已解决 → 等你处理的短词（见 childWord）→ 计划 n/m → 执行中 / 等结果 / 待收尾 →
 * 停下的原因。同一行只说一件事，全部从 childIcon / childState 派生，
 * 所以不会出现「已解决」和「执行中」同屏（以前徽标按 resolved/asking/plan 各算一套就是这么来的）。
 * 「已关闭」也一样只认 childIcon（见 convGone）：还在跑的对话不说它关了。
 */
export function childLabels(c: ChildSummary): ChildLabel[] {
  const icon = childIcon(c)
  const state = childState(c)
  const out: ChildLabel[] = []
  if (convGone(c) === 'closed') out.push({ text: t('已关闭'), tone: 'plain' })
  if (c.resolved && icon === 'done') out.push({ text: t('已解决'), tone: 'success', icon: 'check' })
  // 等你处理的短词（等你回答 / 等你确认 / 阶段待确认 / 等你操作 / 子对话等你处理）和标题栏、侧栏、
  // 子对话自己页面的输入框占位同一处取（shared/task-word.ts，分析稿 A8、U2）：以前这里写「等用户选择」，
  // 侧栏写「等你回复」，同一件事两种说法
  if (icon === 'waiting') out.push({ text: childWord(c).word, tone: 'warning' })
  // 用户报的 Bug（ADR 0046）：查到哪个阶段了；等你确认报告时下面写「报告待确认」，这里只说是 Bug
  if (c.bug)
    out.push({
      text: c.diagnosis || icon === 'done' ? t('Bug') : t('Bug · {stage}', { stage: c.bug }),
      tone: 'plain',
      dots: c.bugStep,
    })
  // 进程回收了的「未完成」画成静止（见 childIcon），计划进度和「未完成」照样写，只是不再用执行中的颜色
  const parked = icon === 'idle' && state === 'unfinished'
  if ((icon === 'running' || parked) && c.plan)
    out.push({ text: t('计划 {done}/{total}', { done: c.plan.done, total: c.plan.total }), tone: 'warning' })
  // 交了 Bug 诊断报告、等你确认（ADR 0045）：还在转圈（没做完），但状态写成「报告待确认」并用提醒色，
  // 一眼和别的「执行中」分开，知道是这一个在等你看报告
  // 等报告时又提了问（图标是 waiting，前面已经写了「等你选择 / 确认」）：仍写出报告在等确认，这一行留在运行区
  if ((icon === 'running' || icon === 'waiting') && c.diagnosis) out.push({ text: t('报告待确认'), tone: 'warning' })
  else if (icon === 'running') out.push({ text: convStateText(state), tone: state === 'wrapup' ? 'success' : 'accent' })
  if (parked) out.push({ text: convStateText(state), tone: 'subtle' })
  // 停下也说清是谁结束的：只有用户按的暂停才是「已暂停」（见 stopReasonText）。
  // 静止的「未完成」没有停下原因（这一轮是正常说完的）就不写，免得写成「已暂停」
  if ((icon === 'stopped' || icon === 'idle') && !(parked && !c.stopReason))
    out.push({ text: stopReasonText(c.stopReason), tone: 'subtle' })
  // 进程回收了、这一轮停下但还有没做完的（计划没做完）：行上补一句继续会重新拉起。
  // 静止的行以前只有悬停里能看到这句，一排卡片只剩「页面切走后结束」，用户以为再也起不来了
  // plan 来自 openPlan：只在计划没做完时才有值（做完了是 undefined）
  if (icon === 'idle' && c.plan) out.push({ text: t('Agent 进程已回收，继续会重新拉起'), tone: 'subtle' })
  return out
}

/**
 * 进程回收了、对话却还在跑：这一行不写「已关闭」，但要让人知道进程确实没了（发消息会重新拉起、接着做）。
 * 只给还在跑 / 还在等你处理的（见 convGone）：停下、做完、失败的不提这句
 */
export function childClosedHint(c: ChildSummary) {
  return convGone(c) === 'hint' ? t('Agent 进程已回收，继续会重新拉起') : ''
}

/** 标签样式：小胶囊带底色的是「状态」，纯文字是「说明」，和列表里的层级一致。带底色的按 chip-lift 提回去，
 * 否则胶囊中心比同一行的正文低一档（见 index.css 的 chip-lift） */
export const childLabelClass: Record<ChildLabelTone, string> = {
  success: 'chip-lift flex shrink-0 items-center gap-0.5 rounded-full bg-success/12 px-1.5 text-caption text-success',
  warning: 'chip-lift shrink-0 rounded-full bg-warning/15 px-1.5 text-caption text-warning',
  accent: 'shrink-0 text-caption text-accent-text',
  subtle: 'shrink-0 text-caption text-subtle',
  plain: 'chip-lift shrink-0 rounded-full bg-field px-1.5 text-caption text-subtle',
}

/**
 * 交了诊断报告等你确认（ADR 0045）、又在等你回答提问或确认请求的子对话：状态是「等你处理」（convState 里
 * requests / asking 排在诊断前面），不转圈，visibleChildren 不列它。以前运行区里这一行就此消失，
 * 只剩输入框上方「等你回答」那一条，看着像子对话行被提问顶掉了（用户报的现象）。
 * 运行区照旧留着这一行（行尾还是「查看报告」），提问另外显示。停下的、已收起的不算：报告不再算在跑
 */
export const reportAsking = (c: ChildEntry) =>
  !!c.diagnosis && c.status !== 'stopped' && !c.gone && childIcon(c) === 'waiting'

/**
 * 工作流节点做完、等你确认这一步结果的子对话（请求 kind 'confirm'）：工作流还没走完，和诊断报告一样
 * 算「还在进行」——运行区、子对话小块一直留着这一行（提醒色转圈），行尾「查看结果」在父对话页直接打开审阅弹窗。
 * 以前它不转圈（convState 是「等你处理」），只在输入框上方单独起一条黄色确认条，用户要求去掉那条、
 * 改成和诊断报告一样留在子对话行上。已收起、已解决的不算：没人再处理它的请求。
 * 停下了也算：请求还挂着，工作流还没走完（只是不再转圈，见 RunningNow）
 */
export const stageConfirm = (c: Pick<ChildEntry, 'resolved' | 'gone'> & { request?: Pick<ChildRequest, 'kind'> }) =>
  c.request?.kind === 'confirm' && !c.resolved && !c.gone

/**
 * 在等你处理的子对话（提问、等你操作 request_user_action、权限确认、它下面的子对话在等）：
 * 对话还没做完，只是卡在你这里。以前运行区只列转圈的（visibleChildren），这一类不转圈就整行消失，
 * 父对话里看不出有个子对话在等你（用户 2026-11-07 报：子对话「等用户操作」时父对话的子对话列表里没有它）。
 * 和 reportAsking 同一条线：停下的、已收起的不算（没人再处理），已解决的也不算
 */
export const childNeedsYou = (c: ChildEntry) =>
  childIcon(c) === 'waiting' && c.status !== 'stopped' && !c.gone && !c.resolved

/**
 * 运行区列的子对话：转圈的那一批（visibleChildren）加上在等你处理的（提问、等你操作、等诊断报告时又提了问）、
 * 等你确认工作流阶段结果的；顺序同 sortChildren
 */
export function listedChildren<C extends ChildEntry & { request?: Pick<ChildRequest, 'kind'> }>(children: C[]): C[] {
  const shown = new Set(visibleChildren(children))
  const extra = children.filter((c) => !shown.has(c) && (reportAsking(c) || childNeedsYou(c) || stageConfirm(c)))
  return extra.length ? sortChildren([...visibleChildren(children), ...extra]) : visibleChildren(children)
}
