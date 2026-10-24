/**
 * 对话的执行计划（task.plans）：Agent 用 set_plan 交整份列表，面板在这里合并，守住几条规则：
 * - 最多两层：主步骤和子步骤
 * - 交整份列表时，没写进新列表的未完成步骤算删掉；只交变更步骤（partial）时，没写到的步骤原样留着
 * - 完成的步骤锁死：之后交的列表里改它、删它都无效，同样的内容要做就新加一步
 * - 整份都完成后计划收起（doneAt），这份计划就算结束；之后的新内容直接开一份新计划（finish_plan 只是提前结束）
 * - 等待中的步骤挂着后台命令、子对话：结果回来时 settleWait 按编号找到它，成功就标完成，失败退回进行中
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

/** 收尾步骤的种类：merge 独立分支合回父对话所在的分支，p4 按文件类型分进各自的 pending changelist */
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
 * 整份计划的用时（毫秒）：从计划创建算起。
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
  const start = Number.isFinite(created) ? created : starts.length ? Math.min(...starts) : NaN
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

/** 状态变了记时间：第一次开始做记 startedAt，做完记 endedAt */
function setStatus(item: PlanItem, status: PlanStatus, now: string) {
  if (item.status === status) return
  item.status = status
  if (status !== 'pending' && !item.startedAt) item.startedAt = now
  item.endedAt = status === 'done' ? now : ''
}

/**
 * 合并一层列表：已有的按 id（其次按标题）对上；完成的原样留着、不吃新的改动；
 * 没写进新列表的未完成项删掉，完成的放回原来的位置。
 * keep：只交变更步骤（partial）时为真，没写到的项一律放回原位、当成没动过
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
    const cur =
      old.find((o) => !used.has(o) && id && o.id === id) ?? old.find((o) => !used.has(o) && title && o.title === title)
    if (cur) {
      used.add(cur)
      if (cur.status === 'done') {
        // 完成的不再改：同样的内容要再做，新加一步
        if (asStatus(x.status) !== 'done' || (title && title !== cur.title)) locked.push(cur.title)
        // review 是标记不是内容：已完成的主步骤也允许补上或去掉（模型可能先标完成才发现漏标）。
        // 不能按 'review' in cur 判断：旧计划数据里就没有这个字段，那样标记永远写不进去
        if (withReview && x.review !== undefined) (cur as unknown as PlanStep).review = x.review === true
      } else update(cur, x)
      out.push(cur)
      continue
    }
    if (!title) continue
    // 模型自己起的 id 和已有的重了：换一个，免得之后对不上
    const fresh = id && !ids.has(id) && !out.some((o) => o.id === id) ? id : nextId()
    ids.add(fresh)
    out.push(make(x, fresh))
  }
  // 漏写的完成项放回原位（只交变更步骤时，漏写的未完成项也放回原位）
  old.forEach((o, i) => {
    if (used.has(o) || (o.status !== 'done' && !keep)) return
    out.splice(Math.min(i, out.length), 0, o)
  })
  return out
}

/** 主步骤的状态跟着子步骤走：子步骤都完成就完成，有在做的就算进行中 */
function rollUp(step: PlanStep, now: string) {
  if (step.run || !step.children.length) return
  if (step.children.every((c) => c.status === 'done')) return setStatus(step, 'done', now)
  if (step.status === 'done') return
  if (step.children.some((c) => c.status === 'running')) setStatus(step, 'running', now)
  else if (step.children.some((c) => c.status === 'waiting') && step.status === 'pending')
    setStatus(step, 'waiting', now)
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

/**
 * 计划的最后一步必须是一个没做完的收尾步骤（只要还有没做完的步骤，或者从来没收过尾）：
 * 没有就加（Agent 刚删掉的那个原样放回，id 不变），多写了只留一个，挪到中间的放回最后。
 * 已经做完的收尾留在原位：之后又加了要做的步骤，就在最后再收一次尾
 */
function ensureWrapUp(plan: TaskPlan, kind: WrapUpKind, prev: PlanStep | undefined, nextId: () => string) {
  const open = plan.steps.filter((s) => s.wrapUp && s.status !== 'done')
  const rest = plan.steps.filter((s) => !(s.wrapUp && s.status !== 'done'))
  if (!rest.length) {
    // 只剩收尾这一步：没有别的事要做，计划照常留着它
    plan.steps = open.slice(0, 1)
    return
  }
  const needed = !plan.steps.some((s) => s.wrapUp) || rest.some((s) => !s.wrapUp && s.status !== 'done') || open.length
  if (!needed) return
  const keep: PlanStep = open[0] ??
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
  plan.steps = [...rest, keep]
}

/**
 * set_plan：交整份计划。没有进行中的计划就开一份新的（上一份做完了就可以直接开新的）。
 * wrapUp 是子对话要做的收尾（见 ensureWrapUp），面板保证它是计划的最后一步。
 * 返回给 Agent 的说明里带上合并后的完整计划和每一项的 id
 */
export function applyPlan(
  task: PlanTask,
  input: { title?: string; steps?: PlanItemInput[]; partial?: boolean },
  now = new Date().toISOString(),
  wrapUp?: WrapUpKind,
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
        setStatus(item, asStatus(x.status), now)
        item.note = clean(x.note, 300)
        return item
      },
      (cur, x) => {
        if (x.title?.trim()) cur.title = clean(x.title, 120)
        if (x.note !== undefined) cur.note = clean(x.note, 300)
        setStatus(cur, asStatus(x.status), now)
      },
      () => `${step.id}.${++n}`,
      locked,
      partial,
    )
  }
  const before = plan.steps.filter((s) => s.status !== 'done').map((s) => s.title)
  // 还在等子对话、后台命令的项：结果回来由面板标完成，Agent 自己标完成不算（见下面 held）
  const waitingBefore = new Set(
    plan.steps.flatMap((s) => [s, ...s.children]).filter((x) => x.status !== 'done' && waitingOn(x).length),
  )
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
      setStatus(step, asStatus(x.status), now)
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
      if (want === 'done') for (const c of cur.children) setStatus(c, 'done', now)
      setStatus(cur, want, now)
    },
    () => String(++seq),
    locked,
    partial,
    true,
  )
  const notes0: string[] = []
  if (wrapUp) {
    ensureWrapUp(plan, wrapUp, prevWrap, () => String(++seq))
    // 合回分支只有面板说了算：Agent 自己标完成不算，等合并结果
    const merge = plan.steps.find((s) => s.wrapUp === 'merge' && s.status === 'done' && s === prevWrap)
    if (merge && prevWrapStatus !== 'done') {
      setStatus(merge, prevWrapStatus === 'pending' ? 'pending' : 'running', now)
      notes0.push(`「${merge.title}」由面板在合并成功后标完成：调用 submit_merge，不要自己标。`)
    }
  }
  for (const t of before) if (!plan.steps.some((s) => s.title === t)) dropped.push(t)
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
  for (const s of plan.steps) rollUp(s, now)
  const closed = closeIfDone(target, now)
  const notes = [
    locked.length
      ? `这些步骤已经完成，不再改动：${[...new Set(locked)].map((x) => `「${x}」`).join('、')}。同样的内容还要再做就新加一步。`
      : '',
    dropped.length ? `已从计划里去掉：${dropped.map((x) => `「${x}」`).join('、')}` : '',
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

/** 计划里正在做的那一步（不算收尾；没有进行中的就取在等的那一步）：开子对话时没指定步骤，就挂在它上面 */
export function runningStepId(task: Pick<Task, 'plans'>) {
  const steps = activePlan(task)?.steps.filter((s) => !s.wrapUp) ?? []
  return (steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'waiting'))?.id ?? ''
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
    { ...wait, state: 'waiting' },
  ]
  setStatus(got.item, 'waiting', now)
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
      item.note = `等的结果没成功：${failed.map((x) => x.label || x.ref).join('、')}`
    } else if (item.status === 'waiting') setStatus(item, 'done', now)
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
    const note = clean(`还在等它：${why}`, 300)
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
