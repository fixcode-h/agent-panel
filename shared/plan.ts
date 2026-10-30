/**
 * 对话的执行计划（task.plans）：Agent 用 set_plan 交整份列表，面板在这里合并，守住几条规则：
 * - 最多两层：主步骤和子步骤
 * - 交整份列表时，没写进新列表的未完成步骤算删掉；只交变更步骤（partial）时，没写到的步骤原样留着
 * - 完成的步骤锁死：之后交的列表里改它、删它都无效，同样的内容要做就新加一步
 * - 整份都完成后计划收起（doneAt），这份计划就算结束；之后的新内容直接开一份新计划（finish_plan 只是提前结束）
 * - 等待中的步骤挂着后台命令、子对话：结果回来时 settleWait 按编号找到它，成功就标完成，失败退回进行中
 * - 用时按真实的开始、结束时间算：挂上子对话的步骤从子对话创建时算起、合回时停；
 *   Agent 一次把几个没开始的步骤直接标完成，按顺序摊开上一次记时间到现在这段，不记成 0 秒
 * - 子对话的计划最后一步是面板加的收尾（wrapUp）：合回父对话所在的分支，或者 P4 按文件类型分 changelist。
 *   Agent 漏写、删掉、挪到中间都会被放回最后，免得做完改动就停下、收尾没人做
 * - 派子对话一定挂到某一步（ensureChildStep）：没有能挂的一步就补一步（标 auto），上一份计划已结束就重开它。
 *   auto 步骤 Agent 不知道、不会写进 set_plan，合并时按原索引放回，不当成「不做了」删掉
 * 前后端都用（界面画弹窗、服务端改状态），不能引 node 模块
 */
import { topSteps } from './flow.ts'
import type { PlanItem, PlanStatus, PlanStep, PlanWait, Task, TaskPlan, TaskStep } from './schema.ts'

/** 一份计划最多多少个主步骤、每个主步骤最多多少个子步骤：再多就该拆成几份计划 */
export const MAX_PLAN_STEPS = 20
export const MAX_PLAN_CHILDREN = 15

/**
 * 计划滞后阈值：`running` 的步骤这么久没有任何变化，就在下一轮提示里提醒 Agent 先收口（见 planNotice）。
 * 面板侧检测与界面警示读同一个值。`waiting` 不参与（跑 10 分钟 e2e 是正常的，那时步骤本来就该是等待中）
 */
export const PLAN_STALE_MS = 3 * 60_000

/**
 * 整份换方向的判定比例：这次整份提交里被换掉的未完成步骤超过这个比例，就提示「应该重开一份计划」，
 * 而不是在同一份里大换血（见 ADR 0020 的增量 / 重开规则表）
 */
export const PLAN_RESTART_RATIO = 0.5

/** 一份计划开出来不到这么久就被换掉：提示 Agent 是不是该在原计划上增量更新，而不是反复重建 */
export const PLAN_REBUILD_MIN_MS = 2 * 60_000

type PlanTask = Pick<Task, 'plans' | 'steps'>

/** Agent 交上来的一项（主步骤或子步骤） */
export interface PlanItemInput {
  id?: string
  title?: string
  status?: string
  note?: string
  /** 这一步是评审本次改动（子对话收尾前必须，submit_merge 会校验） */
  review?: boolean
  children?: PlanItemInput[]
}

const STATUSES: PlanStatus[] = ['pending', 'running', 'waiting', 'done', 'skipped']
const STATUS_TEXT: Record<PlanStatus, string> = {
  pending: '待做',
  running: '进行中',
  waiting: '等待中',
  done: '完成',
  skipped: '跳过',
}

/**
 * 终态：不再需要推进、也不算「没做完」。done 是做完了，skipped 是明确不做。
 * failed 不算终态：它表示「有件事需要对话决断」，留在计划里直到改成 running（重做）或 skipped（放弃）。
 * 收尾、进度、折叠头的判定都读它，不要各自写 status === 'done'
 */
export function isSettled(status: PlanStatus): boolean {
  return status === 'done' || status === 'skipped'
}

/**
 * 收尾步骤的种类，永远是计划的最后一步：merge 子对话的独立分支合回父对话所在的分支，
 * p4 子对话按文件类型分进各自的 pending changelist，push 父对话把当前分支推到远端
 */
export type WrapUpKind = NonNullable<PlanStep['wrapUp']>

/** 面板加的收尾步骤长什么样：标题、备注都直接写清楚要做什么，Agent 照着做 */
export const WRAP_UP: Record<WrapUpKind, { title: string; note: string }> = {
  merge: {
    title: '收尾：合回父对话所在的分支',
    note: '前面的步骤都做完、编译测试跑通后调用 submit_merge 请父对话收尾；父对话合进去后面板自动标完成，不用自己标',
  },
  p4: {
    title: '收尾：按文件类型把改动分进各自的 changelist',
    note: '调用 p4_split_changelists：[C++]、[XLSX]（表格）、[Lua]、[Other] 各放一个 pending，不全留在 default 或塞进同一个；每类写一句中文描述。不 submit',
  },
  push: {
    title: '收尾：推送到远端并合并主干',
    note: '前面的步骤都做完、验证通过并本地提交后：先推送当前分支（没有跟踪分支就推到 origin 同名分支并设上跟踪），回读 git status -sb 确认远端与本地一致。推送成功后用 gh 把该分支普通合并到主干：先用 gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 取主干分支名，已有对应 PR 就复用，没有就 gh pr create --base <主干> --head <当前分支>；gh pr checks <PR> --watch 等检查通过后 gh pr merge <PR> --merge，回读 PR 状态确认已合并。不强推、不 --admin、不绕过检查；被拒、PR 冲突、检查失败、分支保护拦截就停下来报告，不直接往主干推。没有可用的 gh 时只推送并说明。推送并合并成功后把这步标完成；这一轮没有提交、远端已是这个提交时也要先用 gh pr view <PR> --json state 确认是 MERGED（本地的 origin/<主干> 可能是合并前的旧引用，不要只靠 git merge-base 判断），确认后才直接标完成',
  },
}

/**
 * 收尾步骤的历史标题：改了标题之后，旧版本里 Agent 已经抄进计划的收尾还要认出来，
 * 否则新计划里会多出一条同义的「收尾」。标题只在 WRAP_UP 里定义，这里只放历史别名
 */
const WRAP_UP_TITLES_LEGACY: Record<WrapUpKind, string[]> = {
  merge: [],
  p4: [],
  push: ['收尾：推送到远端'],
}

/**
 * 计划收尾的答案：主类型之外还有『这一轮算不出来』（undefined）和『明确不推』（'none'），后者能去掉旧的推送收尾。
 * 区分这两种是为了不误删：项目目录这一轮没探测到时不能当成「用户不推了」
 */
export type WrapUpAnswer = WrapUpKind | 'none'

/**
 * 这个对话的计划要不要收尾、收哪种（见 ensureWrapUp）：判定和提示词里「授权情况」那段同一套口径，
 * 免得计划里有一步推送、提示词却写着不许推（或者反过来）
 */
export interface WrapUpInput {
  /** 父对话（用户直接对话的那个）还是子对话 */
  child: boolean
  /** 子对话在独立分支里改（或者要改的时候才开分支） */
  isolated?: boolean
  /** P4 工作区 */
  p4?: boolean
  /** Git 仓库：推送收尾只在 Git 里成立 */
  git?: boolean
  /** 项目设置的推送策略 */
  push?: 'ask' | 'allow' | 'deny'
  /** 这个对话里用户对推送做过的选择 */
  answered?: 'allowed' | 'denied'
}

export function wrapUpKind(x: WrapUpInput): WrapUpKind | undefined {
  if (x.child) {
    if (x.isolated) return 'merge'
    return x.p4 ? 'p4' : undefined
  }
  // 父对话只在明确授权推送时才有这一步：项目设置「不推送」和用户拒绝过都不加；「第一次问一次」还没回答时也不加，
  // 等这一轮问完、下一轮带上 answered 再加。P4 工作区的改动走 changelist，不推 git（工作区建在 git 仓库目录下时
  // 也认到 .git，推上去的会是旧历史）
  if (x.p4 || x.push === 'deny' || x.answered === 'denied') return undefined
  const allowed = x.answered === 'allowed' || x.push === 'allow'
  return allowed && x.git ? 'push' : undefined
}

/** 当前计划：最后一份还没做完的 */
export function activePlan(task: Pick<Task, 'plans'>): TaskPlan | undefined {
  const last = task.plans?.at(-1)
  return last && !last.doneAt ? last : undefined
}

/**
 * 过渡桩：以前是「做完了还没写总结的计划」。现在计划做完就算结束，不再欠总结，这里固定返回 undefined。
 * engine.ts 里那条追要总结的提示线还在引用它，先留着让那段自然失效；engine.ts 清掉引用后连同导出一起删。
 */
export function unsummarized(_task: Pick<Task, 'plans'>): TaskPlan | undefined {
  return undefined
}

/** 弹窗和按钮显示的那份：没做完的，或者最近做完的一份 */
export const shownPlan = (task: Pick<Task, 'plans'>) => task.plans?.at(-1)

/** 工作流运行的节点状态换成计划的状态 */
function stepStatus(s: TaskStep): PlanStatus {
  if (s.status === 'done' || s.status === 'skipped') return 'done'
  if (s.status === 'running') return 'running'
  return 'pending'
}

/** 主步骤的子步骤：工作流运行的主步骤取那次运行的节点，节点标题就是步骤名 */
export function planChildren(task: Pick<Task, 'steps'>, step: PlanStep): PlanItem[] {
  if (!step.run) return step.children
  return topSteps(task, step.run).map((s) => ({
    id: s.id,
    title: s.title,
    status: stepStatus(s),
    note: '',
    waits: [],
    startedAt: s.startedAt ?? '',
    endedAt: s.endedAt ?? '',
  }))
}

/** 计划的进度：完成几个主步骤、一共几个，以及正在做的那一步（子步骤优先） */
export function planProgress(task: PlanTask, plan: TaskPlan) {
  // 已处理：完成 + 明确跳过（都是终态）。进度条和「还剩几步」读它，不会因为一步被跳过就永久卡住
  const done = plan.steps.filter((s) => isSettled(s.status)).length
  let current: { step: PlanStep; child?: PlanItem } | undefined
  for (const s of plan.steps) {
    if (s.status !== 'running') continue
    const child = planChildren(task, s).find((c) => c.status === 'running')
    current = { step: s, child }
    break
  }
  const waiting = plan.steps.filter((s) => s.status === 'waiting' || s.children.some((c) => c.status === 'waiting'))
  return { done, total: plan.steps.length, current, waiting: waiting.length }
}

/** 计划里还没做完的步骤（含子步骤）：`doneAt` 有两种来路——全部做完自动收起，和 finish_plan 提前结束。
 * 只看 `doneAt` 分不出这两种，界面要一起看它，才知道该说「计划已完成」还是「计划已结束，还有 N 步没做完」。
 * 明确跳过的步骤不算遗留（那是处理过的），失败与还在做 / 在等的算 */
export function leftSteps(plan: TaskPlan): PlanItem[] {
  const left: PlanItem[] = []
  for (const s of plan.steps) {
    for (const c of s.children) if (!isSettled(c.status)) left.push(c)
    if (!isSettled(s.status)) left.push(s)
  }
  return left
}

/**
 * 还没做完的主步骤有几个：折叠头说「n 步没做完」用它，和 `planProgress` 的 `total - done` 是同一套计数
 * （同一屏里两个数字必须对得上）。子步骤遗留算在它所属的主步骤里，不再单独计数
 */
export function unfinishedSteps(plan: TaskPlan): number {
  return plan.steps.filter((s) => !isSettled(s.status)).length
}

/**
 * 折叠头该说哪件事：'open' 还在做（说进度）、'done' 全部做完收起、'closed' 提前结束但还有没做完的步骤。
 * 界面只认这一个判据——只看 `doneAt` 的话，提前结束会被说成「计划已完成」，而列表里还挂着等待中的步骤
 */
export function planHeadline(plan: TaskPlan): 'open' | 'closed' | 'done' {
  if (!plan.doneAt) return 'open'
  return leftSteps(plan).length ? 'closed' : 'done'
}

/**
 * 一项的最后变化时间（毫秒）：有 updatedAt 用它，旧数据退回 startedAt。
 * 解析不出来时返回 undefined（不能当 0——那会变成「很久以前」，所有旧计划都被判成滞后）
 */
export function itemUpdatedAt(item: PlanItem): number | undefined {
  const at = Date.parse(item.updatedAt || item.startedAt || '')
  return Number.isFinite(at) ? at : undefined
}

/** 一份计划的最后变化时间（毫秒）：旧数据退回创建时间；取不到返回 undefined */
export function planUpdatedAt(plan: TaskPlan): number | undefined {
  const at = Date.parse(plan.updatedAt || plan.createdAt || '')
  return Number.isFinite(at) ? at : undefined
}

/** 现在在做的项：running 的主步骤；它有 running 的子步骤时取子步骤（那才是对话真正在动手的） */
export function runningItem(task: PlanTask): { item: PlanItem; step: PlanStep } | undefined {
  const plan = activePlan(task)
  if (!plan) return undefined
  for (const s of plan.steps) {
    if (s.status !== 'running') continue
    const child = s.children.find((c) => c.status === 'running')
    return { item: child ?? s, step: s }
  }
  return undefined
}

/**
 * 计划滞后：有 running 的步骤，且它超过阈值没变化。waiting 和要修的那一步不参与：
 * 前者本来就该在等（跑 10 分钟 e2e 正常），后者已经点名要先修
 */
export function staleStep(task: PlanTask, now = Date.now(), staleMs = PLAN_STALE_MS) {
  const cur = runningItem(task)
  // 要修的那一步（等的结果没成功）：「现在」那一行已经点名先修它，不再另提一条滞后
  if (!cur || needsFix(cur.item)) return undefined
  const at = itemUpdatedAt(cur.item)
  if (at === undefined) return undefined
  const ms = now - at
  if (ms < staleMs) return undefined
  return { item: cur.item, step: cur.step, ms, since: at }
}

/**
 * 某一项是不是「进行中但很久没变化」：界面上的小警示标记和 planNotice 用同一个阈值。
 * 把 planNotice 给的那一项和每行自己的判定分开，两者读同一个函数，不会出现「提示词说滞后、界面不标」
 */
export function itemStale(item: PlanItem, now: number, staleMs = PLAN_STALE_MS): number | undefined {
  if (item.status !== 'running' || needsFix(item)) return undefined
  const at = itemUpdatedAt(item)
  if (at === undefined) return undefined
  const ms = now - at
  return ms >= staleMs ? ms : undefined
}

/**
 * 最近一次新要求之后计划没动过：返回那次输入距今多久（毫秒）；已经改过计划或已经提醒过那一次时返回 undefined。
 * 「提醒过」记在 inputNotedAt 上——只提醒一次，否则 Agent 选择了「不改计划、说明一句」时会被每轮重复追问
 */
export function inputUnhandled(plan: TaskPlan, now = Date.now()): number | undefined {
  const input = Date.parse(plan.lastInputAt || '')
  if (!Number.isFinite(input)) return undefined
  const noted = Date.parse(plan.inputNotedAt || '')
  if (Number.isFinite(noted) && noted >= input) return undefined
  // 只认对话自己改的（set_plan）：派子对话挂等待、结果回来标完成这些面板替它改的，会让它看起来「改过了」，
  // 新要求其实没进计划（用户要求新要求进来后要排进计划）。旧数据没有这个字段时退回计划的最后变化时间
  const changed = plan.agentUpdatedAt ? Date.parse(plan.agentUpdatedAt) : planUpdatedAt(plan)
  if (changed !== undefined && Number.isFinite(changed) && changed >= input) return undefined
  const ms = now - input
  return ms >= 0 ? ms : undefined
}

/** 多久说成人话：提示词和日志共用一个写法（分钟取整、不足一分钟按 1 分钟说） */
function staleMinutes(ms: number) {
  return Math.max(1, Math.round(ms / 60_000))
}

/**
 * 提示词里的正面自检：「现在：第 2 步「接线」进行中（已 6 分钟），下一步是「跑测试」。」
 * 不是让 Agent 去计划文本里找，而是每轮直接把进度摆在它面前（见 ADR 0020）。
 * 已用时算从开工（startedAt）到现在，和滞后检测用的「多久没变化」是两回事
 */
export function planNowText(task: PlanTask, now = Date.now()): string {
  const plan = activePlan(task)
  if (!plan) return ''
  const order = (s: PlanStep) => plan.steps.indexOf(s) + 1
  const nextOf = (skip?: PlanStep) => plan.steps.find((s) => s !== skip && s.status === 'pending' && !s.wrapUp)
  const fix = plan.steps.find((s) => needsFix(s) || s.children.some(needsFix))
  if (fix)
    return `现在：第 ${order(fix)} 步「${fix.title}」需要修复（${(fix.note || fix.children.find(needsFix)?.note || '').replace(FIX_PREFIX, '')}）：先查清原因、修好后重做，确实不做了就标成跳过并说明原因。`
  const cur = runningItem(task)
  if (cur) {
    const started = Date.parse(cur.item.startedAt)
    const mins = Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 60_000)) : 0
    const next = nextOf(cur.step)
    return `现在：第 ${order(cur.step)} 步「${cur.item.title}」进行中（${mins < 1 ? '刚开始' : `已 ${mins} 分钟`}）${next ? `，下一步是「${next.title}」` : ''}。`
  }
  const waiting = plan.steps.find((s) => s.status === 'waiting')
  if (waiting) {
    const what = waitingOn(waiting)
    const next = nextOf(waiting)
    return `现在：第 ${order(waiting)} 步「${waiting.title}」在等${what.length ? `（${what.join('、')}）` : '结果'}${next ? `，可以接着做「${next.title}」` : ''}。`
  }
  const next = nextOf()
  if (next) return `现在：没有进行中的步骤，下一步是第 ${order(next)} 步「${next.title}」。`
  return ''
}

/**
 * 提示词里要插的计划提醒（滞后 / 新输入后计划没动），没有就空串。
 * 两条检测共用一个入口：提示词、服务端日志都调它，不各写一套。
 * 文本是写给 Agent 看的（不翻译），所以不走 t()
 */
export function planNotice(task: PlanTask, now = Date.now()): string {
  const plan = activePlan(task)
  if (!plan) return ''
  const lines: string[] = []
  const stale = staleStep(task, now)
  if (stale)
    lines.push(
      `⚠ 计划还停在「${stale.item.title}」（已 ${staleMinutes(stale.ms)} 分钟没更新）：` +
        `做完了就把它标完成，在等结果就带 step 重新标成等待中；还在做同一步、内容没变就不用管这条。`,
    )
  const unhandled = inputUnhandled(plan, now)
  if (unhandled !== undefined)
    lines.push(
      `⚠ ${unhandled < 60_000 ? '刚进来了新要求' : `${staleMinutes(unhandled)} 分钟前进来了新要求`}，计划还没有跟着改。` +
        `先判断它要不要进计划：要做的事加进计划（同一件事的细化加子步骤或新步骤，set_plan 增量更新；目标变了就 finish_plan 后开新计划），` +
        `交给子对话的也要在计划里有对应的一步；确实不改变计划，就用一句话说明为什么。`,
    )
  return lines.join('\n')
}

/**
 * 这份计划是「上一份没做完就结束、随后新开的」：界面上标「重建」，也用来提醒重建过于频繁。
 * 一份计划正常做完后开的新计划不算重建
 */
export function planRebuilt(task: Pick<Task, 'plans'>): boolean {
  const plans = task.plans ?? []
  const prev = plans.at(-2)
  return !!prev?.doneAt && leftSteps(prev).length > 0
}

/**
 * 整份计划的用时（毫秒）：从计划创建（或更早开工的步骤）算起。
 * - 全部完成：停在最晚一项的 endedAt；
 * - 提前结束（finish_plan 写了 doneAt，但还有没做完的步骤）：停在 doneAt；
 * - 还在进行：算到调用方传入的 now（每秒更新，所以会一直涨）。
 * - 重开过的计划（reopenedAt）：起点不早于重开时刻，上一轮的用时不并进这一轮
 * 没有 createdAt 的旧数据退到最早一项的 startedAt；一个时间都没有时返回空（不显示）。
 */
export function planSpan(plan: TaskPlan, now: number): number | undefined {
  const items = plan.steps.flatMap((s) => [s, ...s.children])
  const times = (pick: (x: PlanItem) => string) =>
    items.map((x) => Date.parse(pick(x))).filter((n) => Number.isFinite(n))
  const created = Date.parse(plan.createdAt)
  const starts = times((x) => x.startedAt)
  // 步骤可能比计划早开工（先派了子对话、后列的计划）：总用时从最早的那个算，不比单项用时短
  const all = Number.isFinite(created) ? [created, ...starts] : starts
  let start = all.length ? Math.min(...all) : NaN
  // 重开的计划：计划结束后又派了子对话，重开前那段它在一边闲着，不能算进这一轮的用时
  const reopened = Date.parse(plan.reopenedAt ?? '')
  if (Number.isFinite(reopened)) start = Number.isFinite(start) ? Math.max(start, reopened) : reopened
  if (!Number.isFinite(start)) return undefined
  const closedAt = Date.parse(plan.doneAt)
  const ends = times((x) => x.endedAt)
  const allDone = plan.steps.length > 0 && plan.steps.every((s) => isSettled(s.status))
  // 全部完成：停在最晚一项的 endedAt；提前结束（finish_plan）还有没做完的步骤：停在 doneAt。
  // 后者不能拿已完成项的 endedAt 当结束时间，否则总用时比未完成项的单项用时还短
  let end = Number.isFinite(closedAt) ? closedAt : now
  if (allDone && ends.length) end = Math.max(...ends)
  return Math.max(0, end - start)
}

/**
 * 还没做完的计划进度：列表里显示「计划 7/8」，有它就不算交付完（不算已完成）。
 * 计划的步骤全做完时计划已经收起（doneAt），不算「没做完」。
 */
export function openPlan(task: Pick<Task, 'plans' | 'steps'>) {
  const plan = activePlan(task)
  if (!plan) return undefined
  const { done, total } = planProgress(task, plan)
  return done < total ? { done, total } : undefined
}

/** 面板写进 note 的「还在等它」前缀：结果回来时按它认出这是过时的面板说明，Agent 自己写的备注不动 */
export const HOLD_PREFIX = '还在等它：'

/**
 * 计划里没有「失败」：等的结果没成功、工作流没走完，那一步退回进行中，备注以它开头写清原因，
 * 对话去查问题、修好重做（用户 2026-10-30 定的，见 ADR 0032）
 */
export const FIX_PREFIX = '需要修复：'

/** 面板写进 note 的「等的结果没成功」前缀：重跑成功后它同样过时，和 HOLD_PREFIX 一起清掉 */
export const FAIL_PREFIX = `${FIX_PREFIX}等的结果没成功：`

/** 工作流没跑完时写进步骤备注的前缀（见 endRun）：收口后这条和「已完成」矛盾，一起清掉 */
export const RUN_FAIL_PREFIX = `${FIX_PREFIX}工作流没走完：`

/** 旧版本写的失败备注（那时还有「失败」状态）：认得出来，过时了照样清掉 */
const LEGACY_FAIL = ['等的结果没成功：', '工作流没走完：']

/** 这条备注是面板写的「需要修复」说明（含旧版本的写法） */
export const isFixNote = (note: string) => note.startsWith(FIX_PREFIX) || LEGACY_FAIL.some((p) => note.startsWith(p))

/** 这一步要修：进行中、备注是面板写的「需要修复」（等的结果没成功、工作流没走完） */
export const needsFix = (x: { status: PlanStatus; note: string }) => x.status === 'running' && isFixNote(x.note)

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

function asStatus(v: unknown): PlanStatus {
  const s = String(v ?? '').trim()
  // 模型常写 in_progress / completed 这类 TodoWrite 的说法，一起认
  if (s === 'in_progress' || s === 'active') return 'running'
  if (s === 'completed' || s === 'finished') return 'done'
  if (s === 'blocked') return 'waiting'
  // 没有「失败」：没做成就是还要做（修好重做），按进行中记；确实不做了用 skipped
  if (s === 'fail' || s === 'failed' || s === 'error') return 'running'
  if (s === 'skip' || s === 'cancelled' || s === 'canceled') return 'skipped'
  return STATUSES.includes(s as PlanStatus) ? (s as PlanStatus) : 'pending'
}

/** 一项变化了：记下最后变化时间（滞后检测、界面的「N 分钟前更新」都读它） */
function touch(item: PlanItem, now: string) {
  item.updatedAt = now
}

/** 状态变了记时间：第一次开始做记 startedAt（since：知道真正开工的时间就用它），结束时记 endedAt */
function setStatus(item: PlanItem, status: PlanStatus, now: string, since = now) {
  if (item.status === status) return
  item.status = status
  if (status !== 'pending' && !item.startedAt) item.startedAt = since < now ? since : now
  item.endedAt = isSettled(status) ? now : ''
  // 修好了（完成）或明确不做了（跳过）：「需要修复」的说明已经过时，Agent 自己写的备注不动
  if (isSettled(status) && isFixNote(item.note)) item.note = ''
  touch(item, now)
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * 一次直接从「待做」标成完成的几项：这段时间里它们是按顺序做的，把 from 到 to 平分给它们。
 * 不摊的话每一项都是 0 秒（开始和完成记在同一刻），总用时和单项对不上
 */
function spread(items: PlanItem[], from: number, to: number) {
  if (!items.length || !Number.isFinite(from) || !(to > from)) return
  const span = to - from
  items.forEach((x, i) => {
    x.startedAt = iso(from + Math.round((span * i) / items.length))
    x.endedAt = iso(from + Math.round((span * (i + 1)) / items.length))
  })
}

/** 标题归一化：忽略空白、全半角标点和大小写，只有这些差异的改写算同一个步骤 */
function normTitle(t: string) {
  return t
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

/** 交上来的一项对回计划里已有的哪一项：先按 id，其次按标题（归一化后），都已用过的不算 */
function matchOld<T extends PlanItem>(x: PlanItemInput, old: T[], used: Set<T>): T | undefined {
  const id = clean(x.id, 40)
  const title = clean(x.title, 120)
  const byId = id ? old.find((o) => !used.has(o) && o.id === id) : undefined
  if (byId) return byId
  if (!title) return undefined
  const exact = old.find((o) => !used.has(o) && o.title === title)
  if (exact) return exact
  // 只差空白、标点、全半角的改写：还是同一步骤。更大幅度的改写不猜——把「修登录文案」并到「修登录超时」
  // 上会把没做完的步骤标成完成，比多出一条步骤更糟（见 applyPlan 里点名漏写步骤的说明）
  const key = normTitle(title)
  return key ? old.find((o) => !used.has(o) && normTitle(o.title) === key) : undefined
}

/**
 * 合并一层列表：已有的按 id（其次按标题）对上；完成的原样留着、不吃新的改动；
 * 没写进新列表的未完成项删掉。
 * keep：只交变更步骤（partial）时为真，没写到的项一律留着、当成没动过，位置也不动——计划里原有的按原来的顺序，
 * 这次新加的追加到最后。交上来的顺序只决定「谁被更新」，不决定位置：以前按旧下标把漏写项插回已经重排过的列表，
 * 模型把新步骤写在前面时（8 写在 7 前面）两条会互换位置，界面上同一份计划的计数跟着来回变
 */
function mergeLevel<T extends PlanItem>(
  old: T[],
  input: PlanItemInput[],
  make: (x: PlanItemInput, id: string) => T,
  update: (cur: T, x: PlanItemInput) => void,
  nextId: () => string,
  locked: string[],
  keep = false,
  /** 主步骤这一层带 review 标记（子步骤没有这个字段） */
  withReview = false,
): T[] {
  const used = new Set<T>()
  const ids = new Set(old.map((x) => x.id))
  const out: T[] = []
  for (const x of input) {
    const title = clean(x.title, 120)
    const id = clean(x.id, 40)
    const cur = matchOld(x, old, used)
    if (cur) {
      used.add(cur)
      if (cur.status === 'done') {
        // 完成的不再改：同样的内容要再做，新加一步
        if (asStatus(x.status) !== 'done' || (title && title !== cur.title)) locked.push(cur.title)
        // review 是标记不是内容：已完成的主步骤也允许补上或去掉（模型可能先标完成才发现漏标）。
        // 不能按 'review' in cur 判断：旧计划数据里就没有这个字段，那样标记永远写不进去
        if (withReview && x.review !== undefined) (cur as unknown as PlanStep).review = x.review === true
      } else update(cur, x)
      if (!keep) out.push(cur)
      continue
    }
    if (!title) continue
    // 模型自己起的 id 和已有的重了：换一个，免得之后对不上
    const fresh = id && !ids.has(id) && !out.some((o) => o.id === id) ? id : nextId()
    ids.add(fresh)
    out.push(make(x, fresh))
  }
  if (keep) {
    // 原有的都在原位（被更新的只有内容变了），这次新加的排在最后
    const created = out.filter((x) => !old.includes(x))
    return created.length ? [...old, ...created] : old
  }
  // 漏写的完成项放回原来的位置（没写进新列表的未完成项算删掉）
  old.forEach((o, i) => {
    if (used.has(o) || o.status !== 'done') return
    out.splice(Math.min(i, out.length), 0, o)
  })
  return out
}

/** 主步骤的状态跟着子步骤走：子步骤都结束就完成，有失败的就失败，有在做的就算进行中 */
function rollUp(step: PlanStep, now: string) {
  if (step.run || !step.children.length) return
  // 主步骤的开始、结束跟着子步骤的真实时间走：最早开工的子步骤、最晚做完的子步骤
  const first =
    step.children
      .map((c) => c.startedAt)
      .filter(Boolean)
      .sort()[0] ?? now
  // 子步骤里有要修的：主步骤也还在做（需要修复），不能因为其他子步骤做完了就算完成
  if (step.children.some(needsFix)) {
    if (step.status !== 'done') setStatus(step, 'running', now, first)
    return
  }
  if (step.children.every((c) => isSettled(c.status))) {
    const last = step.children
      .map((c) => c.endedAt)
      .filter(Boolean)
      .sort()
      .at(-1)
    return setStatus(step, 'done', last && last < now ? last : now, first)
  }
  if (step.status === 'done') return
  if (step.children.some((c) => c.status === 'running')) setStatus(step, 'running', now, first)
  else if (step.children.some((c) => c.status === 'waiting') && step.status === 'pending')
    setStatus(step, 'waiting', now, first)
}

/** 全部完成时收起计划：记完成时间，这份计划就此结束 */
/**
 * 计划里除了「合回父对话所在的分支」这一步之外还没做完的步骤：子对话只剩合回时才能请父对话收尾。
 * 合回那一步是父对话收尾时由面板标完成的，不能拿它挡住收尾请求本身
 */
export function openWork(task: Pick<Task, 'plans'>): PlanStep[] {
  const plan = activePlan(task)
  return plan ? plan.steps.filter((s) => !isSettled(s.status) && s.wrapUp !== 'merge') : []
}

/**
 * 一项的内容指纹（不含时间戳与 children / review）：判断一次提交是不是真的改了这项。
 * children 的变化各自记在自己的 updatedAt 上；review 是标记不是内容，不算这一步变了
 */
function itemDigest(x: PlanItem): string {
  return [x.id, x.title, x.status, x.note, ...x.waits.map((w) => `${w.kind}:${w.ref}:${w.state}`)].join('\u0001')
}

/** 计划内容的指纹（不含时间戳）：判断一次 set_plan 是不是真的改了计划 */
function planDigest(plan: TaskPlan): string {
  return [plan.title, ...plan.steps.map((s) => [itemDigest(s), ...s.children.map(itemDigest)].join('\u0001'))].join(
    '\u0002',
  )
}

/**
 * 写着「等待中」却没有在等的东西（没有后台命令、子对话、子任务）：按进行中算。
 * 否则界面上那一步永远转圈，而对话其实早就在做别的事。有子步骤在等的主步骤不动（它在等子步骤）
 */
function normalizeWaiting(plan: TaskPlan, now: string): string[] {
  const revived: string[] = []
  for (const s of plan.steps) {
    for (const c of s.children)
      if (c.status === 'waiting' && !c.waits.some((w) => w.state === 'waiting')) {
        setStatus(c, 'running', now)
        revived.push(c.title)
      }
    if (s.status !== 'waiting') continue
    if (s.waits.some((w) => w.state === 'waiting')) continue
    if (s.children.some((c) => c.status === 'waiting')) continue
    setStatus(s, 'running', now)
    revived.push(s.title)
  }
  return revived
}

/**
 * 同一层只能有一个「进行中」：多个时只保留最后一个（对话刚转向的那一步），其余退回待做。
 * 主步骤和子步骤分开算：主步骤进行中、它下面一个子步骤进行中是正常的层级关系
 */
function enforceSingleRunning(plan: TaskPlan, now: string): { title: string; to: PlanStatus }[] {
  const back: { title: string; to: PlanStatus }[] = []
  const collapse = (items: PlanItem[]) => {
    const running = items.filter((x) => x.status === 'running')
    if (running.length < 2) return
    for (const x of running.slice(0, -1)) {
      // 还挂着没回来的结果（子对话 / 后台命令）：退回「等待中」而不是「待做」。
      // settleWait / linkKids 只在状态是 waiting 时收口，退回待做会让这一步永远等不到完成
      const to: PlanStatus = x.waits.some((w) => w.state === 'waiting') ? 'waiting' : 'pending'
      setStatus(x, to, now)
      back.push({ title: x.title, to })
    }
  }
  collapse(plan.steps)
  for (const s of plan.steps) if (s.children.length) collapse(s.children)
  return back
}

/** 计划收起：所有步骤都是终态（完成或明确跳过） */
function closeIfSettled(plan: TaskPlan, now: string) {
  if (plan.doneAt || !plan.steps.length) return false
  if (!plan.steps.every((s) => isSettled(s.status))) return false
  plan.doneAt = now
  plan.updatedAt = now
  return true
}

/** 标题的归一化比较：空格、半角冒号都不算差别（Agent 抄标题时写法不固定） */
const wrapTitle = (title: string) => title.replace(/\s+/g, '').replace(/:/g, '：')

/**
 * Agent 自己写的这一步是不是收尾：照抄了面板的收尾（新开计划时把上一份计划的收尾一起抄过来最常见），
 * 或者自己写了「收尾：合回…」「收尾：…changelist」。认成面板的收尾，不然计划里会有两条一样的收尾
 */
function looksLikeWrapUp(title: string) {
  const t = wrapTitle(title)
  if (Object.values(WRAP_UP).some((w) => wrapTitle(w.title) === t)) return true
  if (
    Object.values(WRAP_UP_TITLES_LEGACY)
      .flat()
      .some((old) => wrapTitle(old) === t)
  )
    return true
  return t.startsWith('收尾') && (t.includes('合回') || /changelist/i.test(t))
}

/**
 * 计划的最后一步必须是一个没做完的收尾步骤（只要还有没做完的步骤，或者是第一份计划从来没收过尾）：
 * 没有就加（Agent 刚删掉的那个原样放回，id 不变），多写了只留一个，挪到中间的放回最后。
 * Agent 自己写的收尾（多半是新开计划时把上一份的收尾抄了过来）：计划里已经有面板的收尾就去掉它，
 * 没有就认成面板的收尾、状态照它写的。做完的收尾之后又有要做的事：重新打开挪到最后。
 * 计划里始终只有一条收尾。分支到底合没合回以 git 为准（见 server/tasks.ts 的 childUnmerged），不靠这一步的状态。
 * 后来开的计划全是做完的步骤（合回后回顾一下做了什么）不再加收尾：已经合回了，加上就永远「只剩合回」
 */
function ensureWrapUp(
  plan: TaskPlan,
  kind: WrapUpKind,
  prev: PlanStep | undefined,
  nextId: () => string,
  now: string,
  first: boolean,
) {
  const copies = plan.steps.filter((s) => !s.wrapUp && looksLikeWrapUp(s.title))
  if (copies.length && plan.steps.some((s) => s.wrapUp)) plan.steps = plan.steps.filter((s) => !copies.includes(s))
  else
    for (const s of copies) {
      s.wrapUp = kind
      s.title = WRAP_UP[kind].title
      s.note = WRAP_UP[kind].note
      s.review = false
    }
  const open = plan.steps.filter((s) => s.wrapUp && !isSettled(s.status))
  const rest = plan.steps.filter((s) => !(s.wrapUp && !isSettled(s.status)))
  if (!rest.length) {
    // 只剩收尾这一步：没有别的事要做，计划照常留着它
    plan.steps = open.slice(0, 1)
    return
  }
  const todo = rest.some((s) => !s.wrapUp && !isSettled(s.status))
  // 推送是每份计划都要做的事，所以这份计划里还没有推送收尾、又有步骤时就加：一轮就把事做完、步骤全标完成时，
  // 只看 first 会漏掉（新开的计划 first 一定是 false），那一轮的改动就永远不推。
  // 已经有收尾的（做完也好、挂着也好）仍按原来的判定：只有 todo / open 才重新打开，推完不折腾。
  // 合回 / 分 changelist 是一次性的收尾，回顾型的计划（全是做完的步骤）不再加，否则永远「只剩收尾」
  const missing = !plan.steps.some((s) => s.wrapUp === kind) && rest.some((s) => !s.wrapUp)
  const needed = todo || open.length || (kind === 'push' ? missing : first && !plan.steps.some((s) => s.wrapUp))
  if (!needed) return
  // 做完的收尾之后又有要做的事：重新打开它挪到最后，不另加一条同名的
  const reopen = open.length ? undefined : plan.steps.filter((s) => s.wrapUp === kind && s.status === 'done').at(-1)
  if (reopen) {
    setStatus(reopen, 'pending', now)
    reopen.note = WRAP_UP[kind].note
  }
  const keep: PlanStep = open[0] ??
    reopen ??
    (prev && !isSettled(prev.status) ? prev : undefined) ?? {
      id: nextId(),
      title: WRAP_UP[kind].title,
      status: 'pending',
      note: WRAP_UP[kind].note,
      waits: [],
      startedAt: '',
      endedAt: '',
      children: [],
      wrapUp: kind,
    }
  // 推送收尾以当前定义为准：升级前就挂在计划里的收尾还写着「推送到远端」，
  // 不同步的话这次对话仍只会推送、不会合并主干。只同步 push，别覆盖合回失败时面板写进 note 的原因
  if (keep.wrapUp === 'push') {
    keep.title = WRAP_UP.push.title
    keep.note = WRAP_UP.push.note
  }
  plan.steps = [...rest.filter((s) => s !== keep), keep]
}

/**
 * 去掉一种还没做完的收尾（连同 Agent 自己照抄了一条同标题的普通步骤），返回有没有删掉东西。
 * 用在授权变了的时候：计划里留着一步永远做不了的收尾，计划就永远算没做完
 */
function dropWrapUp(plan: TaskPlan, kind: WrapUpKind) {
  const titles = [WRAP_UP[kind].title, ...WRAP_UP_TITLES_LEGACY[kind]].map(wrapTitle)
  const list = plan.steps.filter(
    (s) => !isSettled(s.status) && (s.wrapUp === kind || (!s.wrapUp && titles.includes(wrapTitle(s.title)))),
  )
  if (!list.length) return false
  plan.steps = plan.steps.filter((s) => !list.includes(s))
  return true
}

/**
 * set_plan：交整份计划。没有进行中的计划就开一份新的（上一份做完了就可以直接开新的）。
 * wrapUp 是这个对话要做的收尾（见 wrapUpKind 和 ensureWrapUp），面板保证它是计划的最后一步。
 * 返回给 Agent 的说明里带上合并后的完整计划和每一项的 id
 */
export function applyPlan(
  task: PlanTask,
  input: { title?: string; steps?: PlanItemInput[]; partial?: boolean },
  now = new Date().toISOString(),
  /**
   * 这个对话的收尾：不传表示「不用收尾」（合回 / 分 changelist 这类一次性收尾就不做了），
   * 'none' 表示「明确不推送」——只有它能去掉计划里还挂着的推送收尾。
   * 其余情况（这一轮算不出来，例如项目目录没取到）保持收尾原样，下次算出来再收
   */
  wrapUp?: WrapUpKind | 'none',
  /** 这个对话名下的子对话：Agent 在步骤里点到的挂成等待，已经结束的直接收口（见 linkKids） */
  kids?: PlanKid[],
): { ok: boolean; info: string } {
  // 只交变更步骤：步骤一多时分两批交，没写到的未完成步骤不删（模型拼大段 JSON 容易出错）
  const partial = input.partial === true
  const steps = Array.isArray(input.steps) ? input.steps.filter((x) => x && typeof x === 'object') : []
  if (!steps.length) return { ok: false, info: 'steps 是空的：至少写一个主步骤' }
  task.plans ??= []
  let plan = activePlan(task)
  if (!plan) {
    plan = {
      id: `p${task.plans.length + 1}`,
      title: '',
      steps: [],
      createdAt: now,
      doneAt: '',
      summary: '',
      autoSummary: false,
    }
    task.plans.push(plan)
  }
  // 合并前的计划内容（含标题）：合并后真变了才推进计划级的「最后变化时间」
  const digestBefore = planDigest(plan)
  if (input.title?.trim()) plan.title = clean(input.title, 80)
  const locked: string[] = []
  const dropped: string[] = []
  let seq = Math.max(0, ...plan.steps.map((s) => Number(s.id) || 0))
  const target = plan
  // 上一次记下时间的时刻（计划创建、某一步开工或做完）：这次直接从待做标完成的步骤是在这之后做的
  const since = Math.max(
    ...[plan.createdAt, ...plan.steps.flatMap((s) => [s, ...s.children]).flatMap((x) => [x.startedAt, x.endedAt])]
      .map((x) => Date.parse(x))
      .filter((n) => Number.isFinite(n) && n <= Date.parse(now)),
  )
  const jumped = new Set<PlanItem>()
  const mark = (item: PlanItem, status: PlanStatus) => {
    if (status === 'done' && item.status !== 'done' && !item.startedAt) jumped.add(item)
    setStatus(item, status, now)
  }
  const mergeChildren = (step: PlanStep, list: PlanItemInput[] | undefined) => {
    // 工作流运行的子步骤就是它的节点，不收 Agent 写的
    if (step.run || !Array.isArray(list)) return
    if (isSettled(step.status)) {
      if (list.some((c) => !step.children.some((o) => o.id === c.id || o.title === clean(c.title, 120))))
        locked.push(step.title)
      return
    }
    let n = Math.max(0, ...step.children.map((c) => Number(c.id.split('.').pop()) || 0))
    step.children = mergeLevel<PlanItem>(
      step.children,
      list.filter((x) => x && typeof x === 'object').slice(0, MAX_PLAN_CHILDREN),
      (x, id) => {
        const item: PlanItem = {
          id,
          title: clean(x.title, 120),
          status: 'pending',
          note: '',
          waits: [],
          startedAt: '',
          endedAt: '',
        }
        mark(item, asStatus(x.status))
        item.note = clean(x.note, 300)
        return item
      },
      (cur, x) => {
        // 先记内容指纹再动字段：标题也是内容的一部分，只改名字同样要刷新最后变化时间
        const before = itemDigest(cur)
        if (x.title?.trim()) cur.title = clean(x.title, 120)
        if (x.note !== undefined) cur.note = clean(x.note, 300)
        mark(cur, asStatus(x.status))
        // 只在这项内容真的变了时刷新「最后变化时间」：Agent 按习惯把整份计划原样重交一遍，
        // 不该把滞后计时洗掉（计划级用 planDigest 守着，步骤级同样要守，否则滞后检测永远不触发）
        if (itemDigest(cur) !== before) touch(cur, now)
      },
      () => `${step.id}.${++n}`,
      locked,
      partial,
    )
  }
  // 记下合并前还没做完的步骤（按对象）：合并后它还在计划里就算没被去掉。按标题比对会把改写过的标题误报成「去掉」
  const before = plan.steps.filter((s) => !isSettled(s.status))
  // 面板按子对话自动补的步骤（见 ensureChildStep）：Agent 交整份计划时不会写它们，不能当成「不做了」删掉。
  // 记下它们原来在第几位，合并完没被交上来的按原位插回；Agent 自己写了同标题的步骤则照常对上它、改成它的步骤
  const autoBefore = plan.steps.map((s, i) => ({ s, i })).filter((x) => x.s.auto)
  // 还在等子对话、后台命令的项：结果回来由面板标完成，Agent 自己标完成不算（见下面 held）。
  // 连同子步骤一起算：主步骤被标完成时会级联把子步骤也标完成（见 update 里的 want === 'done'）
  const waitingBefore = new Set(plan.steps.flatMap((s) => [s, ...s.children]).filter(waitingDeep))
  // 合并前记下没做完的收尾：Agent 漏写时原样放回，合回分支这种由面板标完成的也要知道它原来的状态
  const prevWrap = plan.steps.find((s) => s.wrapUp && !isSettled(s.status))
  const prevWrapStatus = prevWrap?.status
  plan.steps = mergeLevel<PlanStep>(
    plan.steps,
    steps.slice(0, MAX_PLAN_STEPS),
    (x, id) => {
      const step: PlanStep = {
        id,
        title: clean(x.title, 120),
        status: 'pending',
        note: clean(x.note, 300),
        waits: [],
        startedAt: '',
        endedAt: '',
        children: [],
        review: x.review === true,
      }
      mark(step, asStatus(x.status))
      mergeChildren(step, x.children)
      return step
    },
    (cur, x) => {
      // 同子步骤：指纹要在改标题之前取，否则「只改步骤名」会被当成没变化
      const before = itemDigest(cur)
      if (x.title?.trim()) cur.title = clean(x.title, 120)
      if (x.note !== undefined) cur.note = clean(x.note, 300)
      // review 是标记不是内容：已完成的步骤也允许补上或去掉（模型可能先标完成，才发现漏标）
      if (x.review !== undefined) cur.review = x.review === true
      const want = asStatus(x.status)
      mergeChildren(cur, x.children)
      // 主步骤标了完成：没写完成的子步骤一起算完成（Agent 说这一步做完了）
      if (want === 'done') for (const c of cur.children) mark(c, 'done')
      mark(cur, want)
      // 同子步骤：内容真变了才刷新最后变化时间
      if (itemDigest(cur) !== before) touch(cur, now)
    },
    () => String(++seq),
    locked,
    partial,
    true,
  )
  // 自动补的步骤没被交上来（正常，Agent 不知道有这一步）：原样放回原来的位置，不提示也不删
  for (const { s, i } of autoBefore) {
    if (!plan.steps.includes(s)) plan.steps.splice(Math.min(i, plan.steps.length), 0, s)
  }
  const notes0: string[] = []
  const kind = wrapUp === 'none' ? undefined : wrapUp
  if (kind) {
    ensureWrapUp(plan, kind, prevWrap, () => String(++seq), now, task.plans.length === 1)
    // 合回分支只有面板说了算：Agent 自己标完成不算，等合并结果
    const merge = plan.steps.find((s) => s.wrapUp === 'merge' && s.status === 'done' && s === prevWrap)
    if (merge && prevWrapStatus !== 'done') {
      setStatus(merge, prevWrapStatus === 'pending' ? 'pending' : 'running', now)
      notes0.push(`「${merge.title}」由面板在合并成功后标完成：调用 submit_merge，不要自己标。`)
    }
  } else if (wrapUp === 'none' && dropWrapUp(plan, 'push')) {
    // 推送策略改成不推了（用户拒绝过、或设置改成不推送）：还挂着的推送收尾永远做不了，删掉它计划才收得起来
    notes0.push(`推送收尾已去掉：「${WRAP_UP.push.title}」不在这次的授权里，不用做，也不用再写进计划。`)
  }
  for (const t of before) if (!plan.steps.includes(t) && !t.auto) dropped.push(t.title)
  // 只交变更步骤时漏写的未完成步骤不删也不提示：模型以为「漏写的会算删掉」，实际它一直挂在原位，
  // 界面上就出现早做完的活还写着「进行中/待做」。点名让它按真相处理（以前 13 次 set_plan 的 id 都写空、
  // 一半步骤没再出现，就是从这里开始对不上的）。
  // 「交上来了」沿用 matchOld 的同一套判定（id → 标题完全一致 → 归一化一致）：另写一套精确比对，
  // 会把刚被归一化匹配更新过的步骤又报成没交上来，模型看到互相矛盾的两句话
  const touched = new Set<PlanItem>()
  if (partial)
    for (const x of steps) {
      // 只判断「这一项能不能对回计划里的旧项」，不参与去重：这里传空 Set 与 mergeLevel 共用 used 的语义
      // 不同——同一个旧项被两项命中时 mergeLevel 会新建一条，这里仍算它被交过，所以 left 对这情况
      // 是漏报而不是误报；漏报只是少提醒一句，误报会让模型把已更新的步骤重交一遍
      const got = matchOld(x, before, new Set())
      if (got) touched.add(got)
    }
  // 还在等结果的步骤不点名让模型去交：它由面板在结果回来后收口，让它去「标完成」只会被下面的 held 退回，
  // 同一个回复里就出现「做完了就标完成」和「还在等结果不能自己标」两句互相矛盾的话（模型会白跑一轮改计划）
  // 判定要和 held 的 waitingBefore 完全一致（都递归算子步骤），否则子步骤在等、主步骤却被点名一模一样又白跑一轮
  // 只看还没做完的主步骤；子步骤跟着主步骤走，不单独点名
  // 自动补的步骤不点名让 Agent 交：它不是 Agent 写的，点名只会让它把这一步写进计划当成自己的步骤
  const left = partial ? before.filter((s) => !s.wrapUp && !s.auto && !waitingDeep(s) && !touched.has(s)) : []
  // 子对话还没合回、后台命令还没跑完就标完成：父对话的计划会显示「已完成」，子对话却还卡着。
  // 退回等待中，等结果推回来面板再标；确实不等了用 finish_plan 结束计划
  const held: string[] = []
  for (const s of plan.steps)
    for (const x of [...s.children, s])
      // 结果还没回来就说完成不算：退回等待中，等面板收到结果再收口
      if (x.status === 'done' && waitingBefore.has(x)) {
        setStatus(x, 'waiting', now)
        held.push(`「${x.title}」（等：${waitingOn(x).join('、')}）`)
        // 子步骤退回了，主步骤也不能算完成（rollUp 不会把已完成的主步骤改回去）
        if (x !== s && s.status === 'done') setStatus(s, 'waiting', now)
      }
  // 先把面板能从真实事件挂上的等待挂好（子对话 / 已提到它的步骤），再判断「写着等待中却什么也没在等」：
  // 反过来会把 Agent 写 waiting、下一行才被 linkKids 认出来的步骤先改成进行中，等待就丢了
  if (kids) linkKids(task, target, kids, now)
  // 没有等的东西却写着等待中：实际是在动手（模型常说「等待中」其实早就在做别的），按进行中算
  const revived = normalizeWaiting(plan, now)
  // 同一层只能有一个进行中：多个时只保留最后一个（对话刚转向的那一步），其余退回待做
  const collapsed = enforceSingleRunning(plan, now)
  // 直接标完成的步骤按顺序摊开时间；子步骤摊在所在主步骤的时间里（主步骤也是直接标完成的话）
  const end = Date.parse(now)
  spread(
    plan.steps.filter((s) => jumped.has(s) && s.status === 'done'),
    since,
    end,
  )
  for (const s of plan.steps) {
    const own = jumped.has(s) && s.status === 'done'
    const from = own ? Date.parse(s.startedAt) : Math.max(since, Date.parse(s.startedAt) || since)
    spread(
      s.children.filter((c) => jumped.has(c) && c.status === 'done'),
      from,
      own ? Date.parse(s.endedAt) : end,
    )
  }
  for (const s of plan.steps) rollUp(s, now)
  const closed = closeIfSettled(target, now)
  // 换了方向却还在旧计划上打补丁：提醒应该 finish_plan 后开新计划（见 ADR 0020 的增量 / 重开规则表）
  const restartLike = !partial && before.length >= 2 && dropped.length / before.length > PLAN_RESTART_RATIO
  // 刚重建的计划很快又在整份改：提醒优先在原计划上增量，而不是反复重建
  const created = Date.parse(plan.createdAt)
  const rebuiltFresh =
    !partial && planRebuilt(task) && Number.isFinite(created) && Date.parse(now) - created < PLAN_REBUILD_MIN_MS
  const notes = [
    restartLike
      ? `这次整份提交换掉了 ${dropped.length}/${before.length} 个没做完的步骤：如果目标已经变了，先 finish_plan 结束这份计划、再用 set_plan 开一份新的（旧计划和耗时留在「以前的计划」里）；只是加内容就带 partial 只交变更的步骤。`
      : '',
    rebuiltFresh
      ? `这份计划是刚重建的（${staleMinutes(Date.parse(now) - created)} 分钟前新开的）：如果不是换了方向，应该在原计划上用 set_plan 增量更新（partial: true），不要反复重建。`
      : '',
    collapsed.length
      ? `一份计划里同时只能有一个「进行中」，这些已退回去：${collapsed
          .map((x) => `「${x.title}」→ ${x.to === 'waiting' ? '等待中（它还在等结果，结果回来会收口）' : '待做'}`)
          .join('、')}。先做完当前那一步再标下一步。`
      : '',
    revived.length
      ? `这些步骤写着「等待中」却没有在等的东西（没有后台命令 / 子对话 / 子任务），已按「进行中」算：${revived.map((x) => `「${x}」`).join('、')}。跑长命令、派子对话时带上 step，面板会标成等待中。`
      : '',
    locked.length
      ? `这些步骤已经完成，不再改动：${[...new Set(locked)].map((x) => `「${x}」`).join('、')}。同样的内容还要再做就新加一步。`
      : '',
    dropped.length ? `已从计划里去掉：${dropped.map((x) => `「${x}」`).join('、')}` : '',
    left.length
      ? `这些还没做完的主步骤这次没交上来，还按原来的状态留在计划里：${left.map((x) => `「${x.title}」（${STATUS_TEXT[x.status]}）`).join('、')}。做完了就用同样的 id 或标题标完成；不做了就下次交整份列表（不带 partial）时不再写它。（子步骤跟着所在的主步骤走，不单独点名。）`
      : '',
    // 交给面板收口的那些：说清不用交，免得模型以为漏写了又补一遍（补了也只会被 held 退回）
    partial && before.some(waitingDeep)
      ? `还在等结果的步骤不用交：${before
          .filter(waitingDeep)
          .map((x) => `「${x.title}」`)
          .join('、')}，结果推回来时面板会标完成。`
      : '',
    ...notes0,
    held.length
      ? `这些步骤还在等结果，不能自己标完成：${held.join('、')}。结果推回来时面板会标完成；确实不再等就用 finish_plan 结束这份计划。`
      : '',
    closed ? '计划的步骤全部完成了：这份计划结束，之后有新内容用 set_plan 开新的计划。' : '',
  ].filter(Boolean)
  // 计划内容真变了才推进「最后变化时间」：Agent 把同一份计划原样重交一遍不该把「多久没更新」洗掉，
  // 但真正改了状态/标题/备注时必须记上（界面的「N 分钟前更新」和「新输入后计划有没有动」都读它）
  if (planDigest(plan) !== digestBefore) plan.updatedAt = now
  return { ok: true, info: [`计划已更新：\n${planText(task, target)}`, ...notes].join('\n\n') }
}

/** 这一项还在等的结果（子对话、后台命令）的名字 */
function waitingOn(item: PlanItem) {
  return item.waits.filter((w) => w.state === 'waiting').map((w) => w.label || w.ref)
}

/**
 * 这一项（含它下面的子步骤）还没做完、还挂着等结果：由面板收口，Agent 不该自己标完成、也不用交上来。
 * left、held、waitingBefore 三处必须同口径——主步骤被标完成会级联把子步骤标完成
 */
function waitingDeep(item: PlanItem) {
  if (isSettled(item.status)) return false
  const kids = 'children' in item ? (item as PlanStep).children : []
  return waitingOn(item).length > 0 || kids.some(waitingDeep)
}

/** 计划里正在做的那一步（不算收尾；没有进行中的就取在等的那一步）：开子对话时没指定步骤，就挂在它上面 */
export function runningStepId(task: Pick<Task, 'plans'>) {
  const steps = activePlan(task)?.steps.filter((s) => !s.wrapUp) ?? []
  return (steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'waiting'))?.id ?? ''
}

/** 两段文字有多少个相同的相邻两字（中文按字、英文按词）：用来把子对话对上计划里说的是它的那一步 */
function overlap(a: string, b: string) {
  const grams = (t: string) => {
    const units = t.toLowerCase().match(/[a-z0-9]+|[^\sa-z0-9\p{P}]/gu) ?? []
    return new Set(units.slice(1).map((u, i) => units[i] + u))
  }
  const x = grams(a)
  let n = 0
  for (const g of grams(b)) if (x.has(g)) n++
  return n
}

/**
 * 子对话没指定计划步骤时挂在哪一步：
 * - 计划里已经有一步在等这个子对话（给它发后续消息）：还挂那一步，不挪到正在做的那一步上
 * - 标题和某一步说的是同一件事（新开子对话，一步一个子对话最常见）：挂那一步
 * - 都对不上才挂在正在做的那一步（runningStepId）
 * 以前一律挂正在做的那一步：父对话一口气按步骤开了几个子对话，全挂在第 1 步上，
 * 第 1 步的子对话合回了也一直「等待中」，后面几步谁也不等
 * fallback：对不上时退回「正在做的那一步」。ensureChildStep 传 false——它要看清到底对没对上，
 * 对不上就补一步（都退回正在做的那一步，几个子对话会挤在同一格里）
 */
export function childStepId(task: Pick<Task, 'plans'>, ref: string, title = '', fallback = true) {
  const plan = activePlan(task)
  if (!plan) return ''
  const items = plan.steps.flatMap((s) => [s, ...s.children])
  const own = items.find((x) => !isSettled(x.status) && x.waits.some((w) => w.kind === 'child' && w.ref === ref))
  if (own) return own.id
  if (title.trim()) {
    const scored = plan.steps
      // 自动补的步骤不参与比对：它们的标题都带「子对话：」前缀，会互相误配成同一步（见 ensureChildStep）
      .filter((s) => !s.wrapUp && !s.run && !s.auto && !isSettled(s.status))
      .map((s) => ({ s, n: overlap(s.title, title) }))
      .sort((a, b) => b.n - a.n)
    // 至少对上两处，且比第二名多：分不出是哪一步就不猜
    if (scored[0] && scored[0].n >= 2 && scored[0].n > (scored[1]?.n ?? 0)) return scored[0].s.id
  }
  return fallback ? runningStepId(task) : ''
}

/** 面板按子对话补的步骤的标题前缀：一眼能看出它不是 Agent 列的，也不会和 Agent 自己起的标题撞上 */
export const AUTO_STEP_PREFIX = '子对话：'

/** 新建一份空计划（和 applyPlan、bindRun 里开新计划同一套字段） */
function newPlan(task: PlanTask, now: string): TaskPlan {
  task.plans ??= []
  const plan: TaskPlan = {
    id: `p${task.plans.length + 1}`,
    title: '',
    steps: [],
    createdAt: now,
    doneAt: '',
    summary: '',
    autoSummary: false,
  }
  task.plans.push(plan)
  return plan
}

/** 计划里新步骤的编号：接着已有的最大数字往下排 */
function nextStepId(plan: TaskPlan) {
  return String(Math.max(0, ...plan.steps.map((s) => Number(s.id) || 0)) + 1)
}

/**
 * 派子对话时让它一定挂到计划里的某一步上，返回挂上去的步骤 id（挂不上时返回空串）。
 * 没有能挂的一步就自己补一步（标 auto）：以前没点名 step、计划里也匹配不到时什么也不挂，
 * 子对话在父对话的计划里完全看不见（用户看到「一堆子对话在跑、计划面板还停在上次已完成」）。
 * 三种情况：
 * - 有进行中的计划、能对上某一步：挂那一步，行为和以前一样
 * - 有进行中的计划、对不上：补一步（不新开计划，同一份计划接着往下做）
 * - 上一份计划已经结束：把它重新打开，补一步继续。不新开一份——用户说「更新计划列表」，
 *   这些子对话属于同一次统筹，重开能让它们和之前的步骤在面板里连在一起看
 * auto 步骤在 applyPlan 里受保护，Agent 下次交整份计划时不会被当成「不做了」删掉
 */
export function ensureChildStep(task: PlanTask, ref: string, title: string, now = new Date().toISOString()) {
  const want = clean(title, 120) || AUTO_STEP_PREFIX + ref
  const named = want.startsWith(AUTO_STEP_PREFIX) ? want : AUTO_STEP_PREFIX + want
  let plan = activePlan(task)
  if (!plan) {
    // 上一份计划已经结束：重新打开它（doneAt 清空），这些子对话接着记在它上面。
    // 记下重开时刻：总用时从这一刻重算，不把上一轮的历史时长并进这一轮（见 planSpan）
    plan = task.plans?.at(-1) ?? newPlan(task, now)
    plan.doneAt = ''
    plan.reopenedAt = now
  }
  const hit = childStepId(task, ref, want, false)
  if (hit) return hit
  // 这个子对话原来那一步已经做完（send_to_conversation 又交给它一件新事）：不另开一步，把那一步重新打开，
  // 否则计划里同一件事出现两格，补的这格还没标题可用（send_to_conversation 没有 title）
  const revisit = plan.steps.find((s) => !s.wrapUp && s.waits.some((w) => w.kind === 'child' && w.ref === ref))
  if (revisit) {
    setStatus(revisit, 'pending', now)
    return revisit.id
  }
  const seq = nextStepId(plan)
  const step: PlanStep = {
    id: seq,
    title: named,
    status: 'pending',
    note: '',
    waits: [],
    startedAt: '',
    endedAt: '',
    children: [],
    auto: true,
  }
  // 收尾永远在最后（见 ensureWrapUp）：自动补的步骤插在收尾前面（已做完的收尾也算，它仍是最后一步）
  const wrap = plan.steps.findIndex((s) => s.wrapUp)
  if (wrap >= 0) plan.steps.splice(wrap, 0, step)
  else plan.steps.push(step)
  return step.id
}

/** 找当前计划里的一项（主步骤或子步骤）；parent 是子步骤所在的主步骤 */
function findItem(plan: TaskPlan, id: string): { item: PlanItem; parent?: PlanStep } | undefined {
  for (const s of plan.steps) {
    if (s.id === id) return { item: s }
    const c = s.children.find((x) => x.id === id)
    if (c) return { item: c, parent: s }
  }
  return undefined
}

/**
 * 把一项挂成「等待中」：后台命令、子对话开出去以后调用。返回给 Agent 的一句说明；
 * 找不到这一步、或者它已经完成时不挂，说明原因（命令本身照样已经开始了）
 */
export function bindWait(
  task: PlanTask,
  stepId: string,
  wait: Omit<PlanWait, 'state'>,
  now = new Date().toISOString(),
) {
  const id = stepId.trim()
  if (!id) return ''
  const plan = activePlan(task)
  if (!plan) return `（计划里没有步骤 ${id}：现在没有进行中的计划，先用 set_plan 列计划）`
  const got = findItem(plan, id)
  if (!got) return `（计划里没有步骤 ${id}，没有挂上等待）`
  if (isSettled(got.item.status))
    return `（步骤「${got.item.title}」已经结束（${STATUS_TEXT[got.item.status]}），不能再挂等待；要再做就在计划里新加一步）`
  // 上一轮已经有结果的等待不留：重跑一次失败的测试时，旧的失败不该拖住这次的结果
  got.item.waits = [
    ...got.item.waits.filter((w) => w.state === 'waiting' && !(w.kind === wait.kind && w.ref === wait.ref)),
    { ...wait, state: 'waiting', at: wait.at || now },
  ]
  setStatus(got.item, 'waiting', now, wait.at || now)
  if (got.parent) rollUp(got.parent, now)
  plan.updatedAt = now
  return `计划步骤「${got.item.title}」已标成等待中，结果回来会推给你；现在接着做计划的下一步，不要干等。`
}

/**
 * 等的结果回来了：挂着它的步骤里这一项标成功或失败。一项的等待全部结束时：都成功就标完成，
 * 有失败就标失败并写上什么没成功（failed 是「需要处理」的状态，不是终态）。
 * 返回受影响的步骤，推回对话的消息里点名让 Agent 先处理它们
 */
export function settleWait(
  task: PlanTask,
  kind: PlanWait['kind'],
  ref: string,
  ok: boolean,
  now = new Date().toISOString(),
) {
  const hit: { title: string; done: boolean }[] = []
  const plan = activePlan(task)
  if (!plan) return hit
  const visit = (item: PlanItem, parent?: PlanStep) => {
    const w = item.waits.find((x) => x.kind === kind && x.ref === ref && x.state === 'waiting')
    if (!w) return
    w.state = ok ? 'ok' : 'failed'
    if (item.waits.some((x) => x.state === 'waiting')) {
      hit.push({ title: item.title, done: false })
      return
    }
    const failed = item.waits.filter((x) => x.state === 'failed')
    if (failed.length) {
      // 没有「失败」：退回进行中、写清要修什么，对话查问题修好重做；确实不做了由它标 skipped
      setStatus(item, 'running', now)
      item.note = `${FAIL_PREFIX}${failed.map((x) => x.label || x.ref).join('、')}`
    } else if (item.status === 'waiting') {
      setStatus(item, 'done', now)
      // 等都成功了：holdWait 的「还在等它：…」和上一轮失败留下的「等的结果没成功：…」都已经过时，
      // 留着会让完成的步骤下面挂一行说明。只清面板写的这两种，Agent 自己写的备注（做了什么）留着
      if (item.note.startsWith(HOLD_PREFIX) || isFixNote(item.note)) item.note = ''
    }
    hit.push({ title: item.title, done: isSettled(item.status) })
    if (parent) rollUp(parent, now)
  }
  for (const s of plan.steps) {
    for (const c of s.children) visit(c, s)
    visit(s)
  }
  closeIfSettled(plan, now)
  plan.updatedAt = now
  return hit
}

/**
 * 收口推迟：子对话这一轮结束了但还没交付完，父对话计划里等它的那一步继续等着，note 写清在等什么。
 * 只改等待中的那一项的 note（状态保持 waiting / 父步骤有在做的就还是 running），
 * 不往父对话刷消息——每轮结束都推一条，父对话会被淹没。
 * 返回 note 真的变了的步骤标题；空数组表示计划里没有在等它，不用落盘
 */
export function holdWait(
  task: PlanTask,
  kind: PlanWait['kind'],
  ref: string,
  why: string,
  now = new Date().toISOString(),
): string[] {
  const plan = activePlan(task)
  if (!plan) return []
  const changed: string[] = []
  const visit = (item: PlanItem, parent?: PlanStep) => {
    const w = item.waits.find((x) => x.kind === kind && x.ref === ref && x.state === 'waiting')
    if (!w) return
    const note = clean(`${HOLD_PREFIX}${why}`, 300)
    if (item.status === 'waiting' && item.note === note) return
    item.note = note
    setStatus(item, 'waiting', now)
    if (parent) rollUp(parent, now)
    changed.push(item.title)
  }
  for (const s of plan.steps) {
    for (const c of s.children) visit(c, s)
    visit(s)
  }
  if (changed.length) plan.updatedAt = now
  return changed
}

/**
 * 把计划里的一项立即标完成：转交给父对话创建的子任务结果不在这个对话里（见 ADR 0019），
 * 不能挂等待，否则子对话收尾时一直被这一步拦着。返回给 Agent 的一句说明，找不到这一步时不改计划。
 */
export function finishStepNow(task: PlanTask, stepId: string, note: string, now = new Date().toISOString()) {
  const id = stepId.trim()
  if (!id) return ''
  const plan = activePlan(task)
  if (!plan) return `（计划里没有步骤 ${id}：现在没有进行中的计划，先用 set_plan 列计划）`
  const got = findItem(plan, id)
  if (!got) return `（计划里没有步骤 ${id}）`
  if (isSettled(got.item.status)) return ''
  if (note) got.item.note = clean(note, 300)
  setStatus(got.item, 'done', now)
  if (got.parent) rollUp(got.parent, now)
  closeIfSettled(plan, now)
  plan.updatedAt = now
  return `计划步骤「${got.item.title}」已标完成`
}

/** 这个对话名下的一个子对话（宿主给）：计划按它对上等待、收口 */
export interface PlanKid {
  id: string
  title: string
  createdAt: string
  /** 已经收尾完成（resolved） */
  done: boolean
  /** 完成的时间（取不到就是空，按现在算） */
  endedAt?: string
}

/** 一段文字点到的子对话：写了 id（至少前 6 位，Agent 常写缩写），或者写了它的完整标题 */
function mentioned(text: string, kids: PlanKid[]) {
  const hex = text.toLowerCase().match(/[0-9a-f]{6,}/g) ?? []
  return kids.filter(
    (k) =>
      hex.some((h) => k.id.toLowerCase().startsWith(h)) ||
      (k.title.trim().length >= 4 && text.includes(k.title.trim())),
  )
}

/**
 * 计划和子对话对齐（set_plan、收尾之后都跑一遍），不靠 Agent 记得带 step：
 * - Agent 在待做、等待中的步骤里点到了子对话（写了 id 或标题），或者上一份计划里同名的步骤在等它：挂上等待，
 *   用时从子对话创建时算起。以前这种步骤只是 Agent 手写的「等待 xxx」，子对话合回了也没人推进，一直显示等待中
 * - 在等的子对话已经收尾完成（结果推回来时计划还没挂上、或者换了一份计划）：按它完成的时间标完成
 * 返回计划有没有变
 */
function linkKids(task: PlanTask, plan: TaskPlan, kids: PlanKid[], now: string) {
  if (!kids.length) return false
  const byId = new Map(kids.map((k) => [k.id, k]))
  // 以前的计划里还在等的子对话：计划换了一份，等待跟着同名的步骤走
  const carried = new Map<string, string[]>()
  for (const old of task.plans ?? [])
    if (old !== plan)
      for (const x of old.steps.flatMap((s) => [s, ...s.children]))
        if (!isSettled(x.status))
          for (const w of x.waits)
            if (w.kind === 'child' && w.state === 'waiting')
              carried.set(x.title, [...(carried.get(x.title) ?? []), w.ref])
  let changed = false
  const visit = (x: PlanItem, parent?: PlanStep) => {
    if (isSettled(x.status) || (parent ?? (x as PlanStep)).wrapUp || (parent ?? (x as PlanStep)).run) return
    if (x.status === 'pending' || x.status === 'waiting') {
      const want = new Map(mentioned(`${x.title} ${x.note}`, kids).map((k) => [k.id, k]))
      for (const ref of carried.get(x.title) ?? []) {
        const k = byId.get(ref)
        if (k) want.set(k.id, k)
      }
      for (const k of want.values()) {
        if (x.waits.some((w) => w.kind === 'child' && w.ref === k.id)) continue
        x.waits.push({ kind: 'child', ref: k.id, label: k.title, state: 'waiting', at: k.createdAt })
        setStatus(x, 'waiting', now, k.createdAt || now)
        // 子对话比这一步标等待早开工：用时从子对话开工算起
        if (k.createdAt && k.createdAt < x.startedAt) x.startedAt = k.createdAt
        changed = true
      }
    }
    // 在等的子对话已经完成了：结果早就回来了，这一步不该还挂着
    let end = ''
    for (const w of x.waits) {
      const k = w.kind === 'child' && w.state === 'waiting' ? byId.get(w.ref) : undefined
      if (!k?.done) continue
      w.state = 'ok'
      const at = k.endedAt && k.endedAt < now ? k.endedAt : now
      if (at > end) end = at
      changed = true
    }
    if (end && x.status === 'waiting' && !x.waits.some((w) => w.state === 'waiting')) {
      // 和 settleWait 同一口径：没成功就退回进行中、写清要修什么
      if (x.waits.some((w) => w.state === 'failed')) {
        setStatus(x, 'running', now)
        x.note = `${FAIL_PREFIX}${x.waits
          .filter((w) => w.state === 'failed')
          .map((w) => w.label || w.ref)
          .join('、')}`
      } else setStatus(x, 'done', end > x.startedAt ? end : now)
    }
    if (parent) rollUp(parent, now)
  }
  for (const s of plan.steps) {
    for (const c of s.children) visit(c, s)
    visit(s)
  }
  if (changed) plan.updatedAt = now
  return changed
}

/** 宿主在收尾、子对话结束后调：当前计划和名下子对话对齐（见 linkKids），步骤全完成就收起。返回计划有没有变 */
export function syncKids(task: PlanTask, kids: PlanKid[], now = new Date().toISOString()) {
  const plan = activePlan(task)
  if (!plan) return false
  const changed = linkKids(task, plan, kids, now)
  closeIfSettled(plan, now)
  return changed
}

/**
 * 父对话收尾一个子对话（finish_child）之后刷新计划：等它的那一步按子对话现在的状态收口
 * （report 来自 childReport：ok 标完成、fail 退回进行中、hold 继续等并写清在等什么），返回给父对话 Agent 看的计划文字。
 * report 为空（子对话找不到了）只出计划。计划里没有步骤在等它时点明，让 Agent 自己把对应步骤标好。
 * 没有进行中的计划返回空串
 */
export function refreshChildWait(
  task: PlanTask,
  child: { id: string; title: string },
  report?: { settle: 'hold' | 'ok' | 'fail'; why: string },
  now = new Date().toISOString(),
) {
  const plan = activePlan(task)
  if (!plan) return ''
  const tracked = plan.steps
    .flatMap((s) => [...s.children, s])
    .some((x) => x.waits.some((w) => w.kind === 'child' && w.ref === child.id))
  if (report?.settle === 'hold') holdWait(task, 'child', child.id, report.why, now)
  else if (report) settleWait(task, 'child', child.id, report.settle === 'ok', now)
  // settleWait 在步骤全完成时会把计划收起：收起了也要把最后的样子给 Agent 看
  const missing =
    report && !tracked ? `\n计划里没有步骤在等子对话「${child.title}」：对照它的结果用 set_plan 把对应的步骤标好。` : ''
  return `收尾后的计划：\n${planText(task, plan)}${missing}`
}

/** 推回对话的结果前面加一句：它是计划里哪一步在等的，先处理这一步 */
export function waitNote(hit: { title: string; done: boolean }[]) {
  if (!hit.length) return ''
  const names = hit.map((h) => `「${h.title}」`).join('、')
  return hit.every((h) => h.done)
    ? `（计划步骤${names}等的结果到了，已标为完成：先看一眼结果，有问题再在计划里新加一步处理，然后接着按计划做。）\n`
    : `（计划步骤${names}等的结果到了：先处理这一步，再接着按计划做。）\n`
}

/** 工作流做主步骤：start_plan 启动时挂上运行编号；没指定步骤就在计划末尾加一步 */
export function bindRun(task: PlanTask, stepId: string, run: number, title: string, now = new Date().toISOString()) {
  task.plans ??= []
  let plan = activePlan(task)
  if (!plan) {
    plan = {
      id: `p${task.plans.length + 1}`,
      title: '',
      steps: [],
      createdAt: now,
      doneAt: '',
      summary: '',
      autoSummary: false,
    }
    task.plans.push(plan)
  }
  let step = plan.steps.find((s) => s.id === stepId.trim() && !isSettled(s.status))
  if (!step) {
    const seq = Math.max(0, ...plan.steps.map((s) => Number(s.id) || 0)) + 1
    step = { id: String(seq), title, status: 'pending', note: '', waits: [], startedAt: '', endedAt: '', children: [] }
    // 收尾永远在最后：新加的工作流步骤插在它前面
    const wrap = plan.steps.findIndex((s) => s.wrapUp && !isSettled(s.status))
    if (wrap >= 0) plan.steps.splice(wrap, 0, step)
    else plan.steps.push(step)
  }
  step.run = run
  step.children = []
  setStatus(step, 'running', now)
  plan.updatedAt = now
  return step.id
}

/**
 * 面板替 Agent 推进收尾步骤：请父对话收尾时标等待中，合进去标完成，没合进去退回进行中写上原因。
 * 没有进行中的计划、计划里没有这种收尾时什么也不做（没列计划的子对话照旧按 submit_merge 收尾）
 */
export function markWrapUp(
  task: PlanTask,
  kind: WrapUpKind,
  status: 'running' | 'waiting' | 'done',
  note = '',
  now = new Date().toISOString(),
) {
  const plan = activePlan(task)
  const step = plan?.steps.find((s) => s.wrapUp === kind && !isSettled(s.status))
  if (!plan || !step) return false
  setStatus(step, status, now)
  if (note) step.note = clean(note, 300)
  closeIfSettled(plan, now)
  plan.updatedAt = now
  return true
}

/** 工作流跑完：成功标完成，失败标失败并记下原因，交给 Agent 处理 */
export function endRun(task: PlanTask, run: number, ok: boolean, error = '', now = new Date().toISOString()) {
  const plan = activePlan(task)
  const step = plan?.steps.find((s) => s.run === run)
  if (!plan || !step) return
  if (ok) setStatus(step, 'done', now)
  else {
    // 工作流没走完：和等的结果没成功同一口径，退回进行中、写清要修什么
    setStatus(step, 'running', now)
    step.note = clean(`${RUN_FAIL_PREFIX}${error}`, 300)
  }
  closeIfSettled(plan, now)
  plan.updatedAt = now
}

/**
 * 用户手动点「解决」：把最后一份计划里还没做完的步骤（含子步骤、工作流运行的节点）全部收口成完成，
 * 计划落到 done（折叠头走 planHeadline 的 'done' 分支，进度归零）。只在这条路径上调用——父对话收尾
 * （finish_child）、一轮结束收口、后台命令结束仍按原样要求计划真做完（见 shared/task.ts 的 advanceChild）。
 * 还在等的结果一笔勾掉：对话已经解决了，留着「还在等它」只会和「已解决」矛盾。
 * 返回这次收口了几项（0 表示没有要收口、调用方不用落盘）。
 */
export function settlePlan(task: PlanTask, now = new Date().toISOString()): number {
  const plan = shownPlan(task)
  if (!plan) return 0
  let settled = 0
  const close = (item: PlanItem) => {
    if (!isSettled(item.status)) {
      setStatus(item, 'done', now)
      settled++
    }
    // 不再等结果：不记成「等成功」，也不留成「等失败」，就是不等了
    for (const w of item.waits) if (w.state === 'waiting') w.state = 'ok'
    // 面板写的「还在等它：…」「等的结果没成功：…」都已经过时，Agent 自己写的备注留着
    if (item.note.startsWith(HOLD_PREFIX) || isFixNote(item.note)) item.note = ''
  }
  for (const s of plan.steps) {
    for (const c of s.children) close(c)
    close(s)
    // 工作流步骤的子项是那次运行的节点（见 planChildren）：不跟着收口的话折叠头说完成、展开还挂着未完成的节点
    if (s.run !== undefined) settled += settleRunNodes(task, s.run, now)
    if (isFixNote(s.note)) s.note = ''
  }
  if (!settled) return 0
  // doneAt 可能已经有（finish_plan 提前结束过）：closeIfSettled 不会重复写，折叠头按 leftSteps 变 done
  closeIfSettled(plan, now)
  plan.updatedAt = now
  return settled
}

/**
 * 工作流那次运行里没走完的节点标成「跳过」：不谎称做完了，计划面板的 stepStatus 把它算完成。
 * `task.runs` 不动（运行记录是真实历史），只改节点自己的 status；返回改了几个节点
 */
function settleRunNodes(task: PlanTask, run: number, now: string): number {
  let n = 0
  for (const s of topSteps(task, run)) {
    if (s.status === 'done' || s.status === 'skipped') continue
    s.status = 'skipped'
    if (!s.endedAt) s.endedAt = now
    n++
  }
  return n
}

/**
 * finish_plan：结束这份计划。步骤全完成时计划本来就已经收起，这里是主动结束一份还没做完的计划。
 * 不再要求写总结，传了也不保存：计划不再有「欠一份总结」这个状态。
 * kids（这个对话名下的子对话）还没合回时在说明里点名：计划结束后它们就挂不上步骤了，
 * 用户看到的就是「一堆子对话在跑、计划面板写着已完成」（见 ensureChildStep）
 */
export function finishPlan(
  task: PlanTask,
  _summary?: string,
  now = new Date().toISOString(),
  kids: PlanKid[] = [],
): { ok: boolean; info: string } {
  const plan = activePlan(task)
  if (!plan) return { ok: false, info: '现在没有进行中的计划' }
  const left = leftSteps(plan)
  plan.doneAt ||= now
  plan.updatedAt = now
  const running = kids.filter((k) => !k.done)
  return {
    ok: true,
    info: [
      left.length
        ? `这份计划结束了。还有没完成的步骤：${left.map((s) => `${s.id}「${s.title}」（${STATUS_TEXT[s.status]}）`).join('、')}，它们留在计划里。之后有新内容用 set_plan 开新的计划。`
        : '这份计划结束了。之后有新内容用 set_plan 开新的计划。',
      running.length
        ? `这些子对话还没合回：${running.map((k) => `「${k.title}」（${k.id}）`).join('、')}。计划结束后再派子对话会自动重开这份计划并补一步，但它们的进度就不在这次的计划里了：等它们合回再结束计划。`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

/** 计划的文字版：交给 Agent 看（工具结果、每轮提示），带 id 方便它引用 */
export function planText(task: PlanTask, plan: TaskPlan) {
  const mark = (s: PlanStatus) =>
    s === 'done' ? '[x]' : s === 'running' ? '[>]' : s === 'waiting' ? '[~]' : s === 'skipped' ? '[-]' : '[ ]'
  const line = (x: PlanItem, pad: string) => {
    const wait = x.waits.filter((w) => w.state === 'waiting').map((w) => w.label || w.ref)
    const extra = [x.note, wait.length ? `等：${wait.join('、')}` : ''].filter(Boolean).join('；')
    return `${pad}${mark(x.status)} ${x.id} ${x.title}（${STATUS_TEXT[x.status]}）${extra ? `— ${extra}` : ''}`
  }
  const rows: string[] = []
  for (const s of plan.steps) {
    rows.push(line(s, '') + (s.run ? `（工作流第 ${s.run} 次运行）` : ''))
    for (const c of planChildren(task, s)) rows.push(line(c, '  '))
  }
  return `${plan.title ? `「${plan.title}」\n` : ''}${rows.join('\n')}`
}
