/**
 * 对话的执行计划（task.plans）：Agent 用 set_plan 交整份列表，面板在这里合并，守住几条规则：
 * - 最多两层：主步骤和子步骤
 * - 完成的步骤锁死：之后交的列表里改它、删它都无效，同样的内容要做就新加一步
 * - 整份都完成后计划收起（doneAt），必须用 finish_plan 写总结；之后的新内容开一份新计划
 * - 等待中的步骤挂着后台命令、子对话：结果回来时 settleWait 按编号找到它，成功就标完成，失败退回进行中
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
  children?: PlanItemInput[]
}

const STATUSES: PlanStatus[] = ['pending', 'running', 'waiting', 'done']
const STATUS_TEXT: Record<PlanStatus, string> = { pending: '待做', running: '进行中', waiting: '等待中', done: '完成' }

/** 当前计划：最后一份还没做完的 */
export function activePlan(task: Pick<Task, 'plans'>): TaskPlan | undefined {
  const last = task.plans?.at(-1)
  return last && !last.doneAt ? last : undefined
}

/** 做完了还没写总结的计划（最多一份：没写总结前不能开新计划） */
export function unsummarized(task: Pick<Task, 'plans'>): TaskPlan | undefined {
  const last = task.plans?.at(-1)
  return last?.doneAt && !last.summary.trim() ? last : undefined
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
 * 还没做完的计划进度：列表里显示「计划 7/8」，有它就不算交付完（不算已完成）。
 * 计划的步骤全做完了、只是还在写总结的不算（那份已经不会再执行），交给 finish_plan 那一条线。
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
 * 没写进新列表的未完成项删掉，完成的放回原来的位置
 */
function mergeLevel<T extends PlanItem>(
  old: T[],
  input: PlanItemInput[],
  make: (x: PlanItemInput, id: string) => T,
  update: (cur: T, x: PlanItemInput) => void,
  nextId: () => string,
  locked: string[],
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
  // 漏写的完成项放回原位
  old.forEach((o, i) => {
    if (used.has(o) || o.status !== 'done') return
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

/** 全部完成时收起计划：记完成时间，等 finish_plan 写总结 */
function closeIfDone(plan: TaskPlan, now: string) {
  if (plan.doneAt || !plan.steps.length) return false
  if (!plan.steps.every((s) => s.status === 'done')) return false
  plan.doneAt = now
  return true
}

/**
 * set_plan：交整份计划。没有进行中的计划就开一份新的（上一份做完了还没写总结时不让开）。
 * 返回给 Agent 的说明里带上合并后的完整计划和每一项的 id
 */
export function applyPlan(
  task: PlanTask,
  input: { title?: string; steps?: PlanItemInput[] },
  now = new Date().toISOString(),
): { ok: boolean; info: string } {
  const steps = Array.isArray(input.steps) ? input.steps.filter((x) => x && typeof x === 'object') : []
  if (!steps.length) return { ok: false, info: 'steps 是空的：至少写一个主步骤' }
  const owed = unsummarized(task)
  if (owed)
    return {
      ok: false,
      info: `上一份计划「${owed.title || '未命名'}」已经全部完成，还没写总结：先调用 finish_plan 写总结，再开新的计划。`,
    }
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
    )
  }
  const before = plan.steps.filter((s) => s.status !== 'done').map((s) => s.title)
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
      }
      setStatus(step, asStatus(x.status), now)
      mergeChildren(step, x.children)
      return step
    },
    (cur, x) => {
      if (x.title?.trim()) cur.title = clean(x.title, 120)
      if (x.note !== undefined) cur.note = clean(x.note, 300)
      const want = asStatus(x.status)
      mergeChildren(cur, x.children)
      // 主步骤标了完成：没写完成的子步骤一起算完成（Agent 说这一步做完了）
      if (want === 'done') for (const c of cur.children) setStatus(c, 'done', now)
      setStatus(cur, want, now)
    },
    () => String(++seq),
    locked,
  )
  for (const t of before) if (!plan.steps.some((s) => s.title === t)) dropped.push(t)
  for (const s of plan.steps) rollUp(s, now)
  const closed = closeIfDone(target, now)
  const notes = [
    locked.length
      ? `这些步骤已经完成，不再改动：${[...new Set(locked)].map((x) => `「${x}」`).join('、')}。同样的内容还要再做就新加一步。`
      : '',
    dropped.length ? `已从计划里去掉：${dropped.map((x) => `「${x}」`).join('、')}` : '',
    closed ? '计划的步骤全部完成了：现在调用 finish_plan 写总结（必须）。' : '',
  ].filter(Boolean)
  return { ok: true, info: [`计划已更新：\n${planText(task, target)}`, ...notes].join('\n\n') }
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

/** 子对话这一轮结束时还差什么没交付：由调用方按服务端的状态算好传进来（计划在下面自己看） */
export interface ChildTurnLeft {
  /** 这个子对话还有正在跑、排队等着跑的后台命令（名字） */
  background?: string[]
  /** 这一轮结束后还会接着执行：排队的要求、面板交过来的消息、正要开始的下一轮 */
  more?: boolean
}

export interface ChildTurnSettle {
  over: boolean
  ok: boolean
  /** 不收口时在等什么：写进父对话计划那一步的 note；收口时是一句说明 */
  why: string
}

/**
 * 子对话这一轮结束（跑完一轮、CLI 停在等用户下一句）时，父对话计划里等它的那一步该怎么收口。
 * 「这一轮回复完了」不等于「子对话交付完了」：面板判定的完成条件是计划做完、后台命令收尾、
 * 没有待答的提问、不在执行。所以收口要按下面这些条件看，不能只看 working：
 * - 还有没答的提问 / 确认：子对话是停下来等用户（死约定：子对话要停下等用户时必须先提问），继续等
 * - 被停止、执行失败：算结束但没成功，退回进行中并写上原因（settleWait 本来就这个语义）
 * - 还在执行、这一轮结束后还会接着做、还有后台命令在跑、计划还没做完：继续等，不标完成
 * - 这些都没有：交付完了，算成功
 */
export function childTurnSettle(
  task: Pick<Task, 'status' | 'working' | 'requests' | 'plans'>,
  left: ChildTurnLeft = {},
): ChildTurnSettle {
  if (task.requests.length) return { over: false, ok: false, why: '子对话有没答的提问，在等用户回答' }
  if (task.status === 'failed') return { over: true, ok: false, why: '子对话执行失败了' }
  if (task.status === 'stopped') return { over: true, ok: false, why: '子对话被停止了' }
  if (task.working) return { over: false, ok: false, why: '子对话还在执行' }
  if (left.more) return { over: false, ok: false, why: '子对话这一轮结束后还要接着处理排队的消息' }
  const jobs = left.background ?? []
  if (jobs.length)
    return {
      over: false,
      ok: false,
      why: `子对话还有后台命令在跑：${jobs.map((x) => `「${x}」`).join('、')}`,
    }
  // 计划做完了会收起（doneAt），这时 activePlan 是 undefined，不会再挡住收口
  const plan = activePlan(task)
  const todo = plan ? plan.steps.filter((s) => s.status !== 'done') : []
  if (todo.length)
    return {
      over: false,
      ok: false,
      why: `子对话的计划还没做完：${todo
        .slice(0, 3)
        .map((s) => `「${s.title}」`)
        .join('、')}${todo.length > 3 ? ` 等 ${todo.length} 步` : ''}`,
    }
  return { over: true, ok: true, why: '子对话交付完了：计划、后台命令都收尾了' }
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
  if (unsummarized(task)) return ''
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
    plan.steps.push(step)
  }
  step.run = run
  step.children = []
  setStatus(step, 'running', now)
  return step.id
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

/** finish_plan：给做完的计划写总结。还有没完成的步骤时不收 */
export function finishPlan(task: PlanTask, summary: string): { ok: boolean; info: string } {
  const text = summary.trim()
  if (!text) return { ok: false, info: 'summary 是空的：写这份计划做了什么、结果怎样、有什么遗留' }
  const owed = unsummarized(task)
  if (owed) {
    owed.summary = text.slice(0, 6000)
    owed.autoSummary = false
    return { ok: true, info: '总结已记下，这份计划结束。之后有新内容时用 set_plan 开新的计划。' }
  }
  const cur = activePlan(task)
  if (!cur) return { ok: false, info: '现在没有要写总结的计划' }
  const left = cur.steps.filter((s) => s.status !== 'done')
  return {
    ok: false,
    info: `计划还有没完成的步骤：${left.map((s) => `${s.id}「${s.title}」（${STATUS_TEXT[s.status]}）`).join('、')}。做完再写总结；不做了就用 set_plan 把它们从计划里去掉。`,
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
