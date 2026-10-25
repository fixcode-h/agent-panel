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
 * 前后端都用（界面画弹窗、服务端改状态），不能引 node 模块
 */
import { topSteps } from './flow.ts'
import type { PlanItem, PlanStatus, PlanStep, PlanWait, Task, TaskPlan, TaskStep } from './schema.ts'

/** 一份计划最多多少个主步骤、每个主步骤最多多少个子步骤：再多就该拆成几份计划 */
export const MAX_PLAN_STEPS = 20
export const MAX_PLAN_CHILDREN = 15

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

const STATUSES: PlanStatus[] = ['pending', 'running', 'waiting', 'done']
const STATUS_TEXT: Record<PlanStatus, string> = { pending: '待做', running: '进行中', waiting: '等待中', done: '完成' }

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
    title: '收尾：推送到远端',
    note: '前面的步骤都做完、验证通过并在本地提交之后，把当前分支推到它跟踪的远端分支（没有跟踪分支就推到 origin 同名分支并设上跟踪）；推完回读 git status -sb 确认，结论里写清推到了哪个远端分支；只做普通推送，不强推，被拒就停下来报告。推成功后把这步标完成；这一轮确实没有任何提交、远端也已经是这个提交时，回读确认后直接标完成并说明原因',
  },
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
  const done = plan.steps.filter((s) => s.status === 'done').length
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

/**
 * 整份计划的用时（毫秒）：从计划创建（或更早开工的步骤）算起。
 * - 全部完成：停在最晚一项的 endedAt；
 * - 提前结束（finish_plan 写了 doneAt，但还有没做完的步骤）：停在 doneAt；
 * - 还在进行：算到调用方传入的 now（每秒更新，所以会一直涨）。
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
  const start = all.length ? Math.min(...all) : NaN
  if (!Number.isFinite(start)) return undefined
  const closedAt = Date.parse(plan.doneAt)
  const ends = times((x) => x.endedAt)
  const allDone = plan.steps.length > 0 && plan.steps.every((s) => s.status === 'done')
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

/** 面板写进 note 的「等的结果没成功」前缀：重跑成功后它同样过时，和 HOLD_PREFIX 一起清掉 */
export const FAIL_PREFIX = '等的结果没成功：'

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
  return STATUSES.includes(s as PlanStatus) ? (s as PlanStatus) : 'pending'
}

/** 状态变了记时间：第一次开始做记 startedAt（since：知道真正开工的时间就用它），做完记 endedAt */
function setStatus(item: PlanItem, status: PlanStatus, now: string, since = now) {
  if (item.status === status) return
  item.status = status
  if (status !== 'pending' && !item.startedAt) item.startedAt = since < now ? since : now
  item.endedAt = status === 'done' ? now : ''
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

/** 主步骤的状态跟着子步骤走：子步骤都完成就完成，有在做的就算进行中 */
function rollUp(step: PlanStep, now: string) {
  if (step.run || !step.children.length) return
  // 主步骤的开始、结束跟着子步骤的真实时间走：最早开工的子步骤、最晚做完的子步骤
  const first =
    step.children
      .map((c) => c.startedAt)
      .filter(Boolean)
      .sort()[0] ?? now
  if (step.children.every((c) => c.status === 'done')) {
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
  return plan ? plan.steps.filter((s) => s.status !== 'done' && s.wrapUp !== 'merge') : []
}

function closeIfDone(plan: TaskPlan, now: string) {
  if (plan.doneAt || !plan.steps.length) return false
  if (!plan.steps.every((s) => s.status === 'done')) return false
  plan.doneAt = now
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
  const open = plan.steps.filter((s) => s.wrapUp && s.status !== 'done')
  const rest = plan.steps.filter((s) => !(s.wrapUp && s.status !== 'done'))
  if (!rest.length) {
    // 只剩收尾这一步：没有别的事要做，计划照常留着它
    plan.steps = open.slice(0, 1)
    return
  }
  const todo = rest.some((s) => !s.wrapUp && s.status !== 'done')
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
    (prev && prev.status !== 'done' ? prev : undefined) ?? {
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
  plan.steps = [...rest.filter((s) => s !== keep), keep]
}

/**
 * 去掉一种还没做完的收尾（连同 Agent 自己照抄了一条同标题的普通步骤），返回有没有删掉东西。
 * 用在授权变了的时候：计划里留着一步永远做不了的收尾，计划就永远算没做完
 */
function dropWrapUp(plan: TaskPlan, kind: WrapUpKind) {
  const title = wrapTitle(WRAP_UP[kind].title)
  const list = plan.steps.filter(
    (s) => s.status !== 'done' && (s.wrapUp === kind || (!s.wrapUp && wrapTitle(s.title) === title)),
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
    if (step.status === 'done') {
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
        if (x.title?.trim()) cur.title = clean(x.title, 120)
        if (x.note !== undefined) cur.note = clean(x.note, 300)
        mark(cur, asStatus(x.status))
      },
      () => `${step.id}.${++n}`,
      locked,
      partial,
    )
  }
  // 记下合并前还没做完的步骤（按对象）：合并后它还在计划里就算没被去掉。按标题比对会把改写过的标题误报成「去掉」
  const before = plan.steps.filter((s) => s.status !== 'done')
  // 还在等子对话、后台命令的项：结果回来由面板标完成，Agent 自己标完成不算（见下面 held）。
  // 连同子步骤一起算：主步骤被标完成时会级联把子步骤也标完成（见 update 里的 want === 'done'）
  const waitingBefore = new Set(plan.steps.flatMap((s) => [s, ...s.children]).filter(waitingDeep))
  // 合并前记下没做完的收尾：Agent 漏写时原样放回，合回分支这种由面板标完成的也要知道它原来的状态
  const prevWrap = plan.steps.find((s) => s.wrapUp && s.status !== 'done')
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
      if (x.title?.trim()) cur.title = clean(x.title, 120)
      if (x.note !== undefined) cur.note = clean(x.note, 300)
      // review 是标记不是内容：已完成的步骤也允许补上或去掉（模型可能先标完成，才发现漏标）
      if (x.review !== undefined) cur.review = x.review === true
      const want = asStatus(x.status)
      mergeChildren(cur, x.children)
      // 主步骤标了完成：没写完成的子步骤一起算完成（Agent 说这一步做完了）
      if (want === 'done') for (const c of cur.children) mark(c, 'done')
      mark(cur, want)
    },
    () => String(++seq),
    locked,
    partial,
    true,
  )
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
  for (const t of before) if (!plan.steps.includes(t)) dropped.push(t.title)
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
  const left = partial ? before.filter((s) => !s.wrapUp && !waitingDeep(s) && !touched.has(s)) : []
  // 子对话还没合回、后台命令还没跑完就标完成：父对话的计划会显示「已完成」，子对话却还卡着。
  // 退回等待中，等结果推回来面板再标；确实不等了用 finish_plan 结束计划
  const held: string[] = []
  for (const s of plan.steps)
    for (const x of [...s.children, s])
      if (x.status === 'done' && waitingBefore.has(x)) {
        setStatus(x, 'waiting', now)
        held.push(`「${x.title}」（等：${waitingOn(x).join('、')}）`)
        // 子步骤退回了，主步骤也不能算完成（rollUp 不会把已完成的主步骤改回去）
        if (x !== s && s.status === 'done') setStatus(s, 'waiting', now)
      }
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
  if (kids) linkKids(task, target, kids, now)
  for (const s of plan.steps) rollUp(s, now)
  const closed = closeIfDone(target, now)
  const notes = [
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
  if (item.status === 'done') return false
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
 */
export function childStepId(task: Pick<Task, 'plans'>, ref: string, title = '') {
  const plan = activePlan(task)
  if (!plan) return ''
  const items = plan.steps.flatMap((s) => [s, ...s.children])
  const own = items.find((x) => x.status !== 'done' && x.waits.some((w) => w.kind === 'child' && w.ref === ref))
  if (own) return own.id
  if (title.trim()) {
    const scored = plan.steps
      .filter((s) => !s.wrapUp && !s.run && s.status !== 'done')
      .map((s) => ({ s, n: overlap(s.title, title) }))
      .sort((a, b) => b.n - a.n)
    // 至少对上两处，且比第二名多：分不出是哪一步就不猜
    if (scored[0] && scored[0].n >= 2 && scored[0].n > (scored[1]?.n ?? 0)) return scored[0].s.id
  }
  return runningStepId(task)
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
  if (got.item.status === 'done') return `（步骤「${got.item.title}」已经完成，不能再挂等待；要再做就在计划里新加一步）`
  // 上一轮已经有结果的等待不留：重跑一次失败的测试时，旧的失败不该拖住这次的结果
  got.item.waits = [
    ...got.item.waits.filter((w) => w.state === 'waiting' && !(w.kind === wait.kind && w.ref === wait.ref)),
    { ...wait, state: 'waiting', at: wait.at || now },
  ]
  setStatus(got.item, 'waiting', now, wait.at || now)
  if (got.parent) rollUp(got.parent, now)
  return `计划步骤「${got.item.title}」已标成等待中，结果回来会推给你；现在接着做计划的下一步，不要干等。`
}

/**
 * 等的结果回来了：挂着它的步骤里这一项标成功或失败。一项的等待全部结束时：都成功就标完成，有失败退回进行中。
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
      setStatus(item, 'running', now)
      item.note = `${FAIL_PREFIX}${failed.map((x) => x.label || x.ref).join('、')}`
    } else if (item.status === 'waiting') {
      setStatus(item, 'done', now)
      // 等都成功了：holdWait 的「还在等它：…」和上一轮失败留下的「等的结果没成功：…」都已经过时，
      // 留着会让完成的步骤下面挂一行说明。只清面板写的这两种，Agent 自己写的备注（做了什么）留着
      if (item.note.startsWith(HOLD_PREFIX) || item.note.startsWith(FAIL_PREFIX)) item.note = ''
    }
    hit.push({ title: item.title, done: item.status === 'done' })
    if (parent) rollUp(parent, now)
  }
  for (const s of plan.steps) {
    for (const c of s.children) visit(c, s)
    visit(s)
  }
  closeIfDone(plan, now)
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
  return changed
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
        if (x.status !== 'done')
          for (const w of x.waits)
            if (w.kind === 'child' && w.state === 'waiting')
              carried.set(x.title, [...(carried.get(x.title) ?? []), w.ref])
  let changed = false
  const visit = (x: PlanItem, parent?: PlanStep) => {
    if (x.status === 'done' || (parent ?? (x as PlanStep)).wrapUp || (parent ?? (x as PlanStep)).run) return
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
      if (x.waits.some((w) => w.state === 'failed')) setStatus(x, 'running', now)
      else setStatus(x, 'done', end > x.startedAt ? end : now)
    }
    if (parent) rollUp(parent, now)
  }
  for (const s of plan.steps) {
    for (const c of s.children) visit(c, s)
    visit(s)
  }
  return changed
}

/** 宿主在收尾、子对话结束后调：当前计划和名下子对话对齐（见 linkKids），步骤全完成就收起。返回计划有没有变 */
export function syncKids(task: PlanTask, kids: PlanKid[], now = new Date().toISOString()) {
  const plan = activePlan(task)
  if (!plan) return false
  const changed = linkKids(task, plan, kids, now)
  closeIfDone(plan, now)
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
  let step = plan.steps.find((s) => s.id === stepId.trim() && s.status !== 'done')
  if (!step) {
    const seq = Math.max(0, ...plan.steps.map((s) => Number(s.id) || 0)) + 1
    step = { id: String(seq), title, status: 'pending', note: '', waits: [], startedAt: '', endedAt: '', children: [] }
    // 收尾永远在最后：新加的工作流步骤插在它前面
    const wrap = plan.steps.findIndex((s) => s.wrapUp && s.status !== 'done')
    if (wrap >= 0) plan.steps.splice(wrap, 0, step)
    else plan.steps.push(step)
  }
  step.run = run
  step.children = []
  setStatus(step, 'running', now)
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
  const step = plan?.steps.find((s) => s.wrapUp === kind && s.status !== 'done')
  if (!plan || !step) return false
  setStatus(step, status, now)
  if (note) step.note = clean(note, 300)
  closeIfDone(plan, now)
  return true
}

/** 工作流跑完：成功标完成，失败退回进行中并记下原因，交给 Agent 处理 */
export function endRun(task: PlanTask, run: number, ok: boolean, error = '', now = new Date().toISOString()) {
  const plan = activePlan(task)
  const step = plan?.steps.find((s) => s.run === run)
  if (!plan || !step) return
  if (ok) setStatus(step, 'done', now)
  else step.note = clean(`工作流没走完：${error}`, 300)
  closeIfDone(plan, now)
}

/**
 * finish_plan：结束这份计划。步骤全完成时计划本来就已经收起，这里是主动结束一份还没做完的计划。
 * 不再要求写总结，传了也不保存：计划不再有「欠一份总结」这个状态。
 */
export function finishPlan(
  task: PlanTask,
  _summary?: string,
  now = new Date().toISOString(),
): { ok: boolean; info: string } {
  const plan = activePlan(task)
  if (!plan) return { ok: false, info: '现在没有进行中的计划' }
  const left = plan.steps.filter((s) => s.status !== 'done')
  plan.doneAt ||= now
  return {
    ok: true,
    info: left.length
      ? `这份计划结束了。还有没完成的步骤：${left.map((s) => `${s.id}「${s.title}」（${STATUS_TEXT[s.status]}）`).join('、')}，它们留在计划里。之后有新内容用 set_plan 开新的计划。`
      : '这份计划结束了。之后有新内容用 set_plan 开新的计划。',
  }
}

/** 计划的文字版：交给 Agent 看（工具结果、每轮提示），带 id 方便它引用 */
export function planText(task: PlanTask, plan: TaskPlan) {
  const mark = (s: PlanStatus) => (s === 'done' ? '[x]' : s === 'running' ? '[>]' : s === 'waiting' ? '[~]' : '[ ]')
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
