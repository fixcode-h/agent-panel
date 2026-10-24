import type { StepUsage, Task, TaskStep } from './schema.ts'

/**
 * 「整个运行」的用量：一个父对话 + 它分出的所有子对话（含多层）+ 它派出的子任务（spawn_agents 的节点）。
 *
 * 为什么单独算：`Task.usage` 只是这个任务自己的累计（含它派出的子任务），子对话是独立的 Task，不在里面。
 * 界面上要显示「总 / 本对话 / 子任务与子对话」，三个数必须加起来正好等于总数，所以口径定成：
 * - 总 = 整棵树里各任务 usage 之和；
 * - 本对话 = 父对话 usage 减去它派出的子任务；
 * - 子任务与子对话 = 总 − 本对话（除法只在这一处做，别处算漏了也不会让三项对不上）。
 *
 * 速度是按 Agent 记的（`Task.usage.agents[id].tps`），一个角色既被父对话自己用、又被子任务用时没法拆开，
 * 算进「本对话」：宁可让本对话的速度偏高，也不让分项加起来超过整体。
 * 速度的三层（本对话 / 子任务与子对话 / 整体）都只用实时的 tps，见 `tpsNow`。
 */

/** 一组 token 的合计：任务累计和节点用量是同一套字段 */
export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export const NO_TOKENS: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
}

/** 用量字段一律按非负数处理：旧数据里可能有空值，读取时不能算出 NaN */
const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function tokensOf(u?: Partial<StepUsage> | null): TokenTotals {
  return {
    inputTokens: num(u?.inputTokens),
    outputTokens: num(u?.outputTokens),
    cacheReadTokens: num(u?.cacheReadTokens),
    cacheWriteTokens: num(u?.cacheWriteTokens),
    costUsd: num(u?.costUsd),
  }
}

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

/** a − b，负数按 0 算：两个数来自不同时刻（执行中任务累计先涨、节点后写）时不能出现负的用量 */
export function subTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  const d = (x: number, y: number) => Math.max(0, x - y)
  return {
    inputTokens: d(a.inputTokens, b.inputTokens),
    outputTokens: d(a.outputTokens, b.outputTokens),
    cacheReadTokens: d(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: d(a.cacheWriteTokens, b.cacheWriteTokens),
    costUsd: d(a.costUsd, b.costUsd),
  }
}

/** 界面上显示的那个总数：输入 + 输出（缓存命中是输入的一部分，不另外加） */
export const tokenCount = (u: Pick<TokenTotals, 'inputTokens' | 'outputTokens'>) => u.inputTokens + u.outputTokens

/** 一组节点的用量之和；传进来的节点自己带上要算的子节点，这里不再往下展开 */
export function stepsTokens(steps: Pick<TaskStep, 'usage'>[]): TokenTotals {
  return steps.reduce((acc, s) => addTokens(acc, tokensOf(s.usage)), NO_TOKENS)
}

/**
 * 对话派出的子任务（spawn_agents 的节点）：主 Agent 下 slot 为 sub 的步骤，以及它们自己的子步骤。
 * 这些节点的用量已经记在任务累计里了，算「父对话本身」时要减掉。
 */
export function helperSteps(task: Pick<Task, 'steps'>): TaskStep[] {
  const roots = task.steps.filter((s) => s.slot === 'sub')
  if (!roots.length) return []
  const prefixes = roots.map((s) => s.id + '/')
  return task.steps.filter((s) => s.slot === 'sub' || prefixes.some((p) => s.id.startsWith(p)))
}

/** 派出的子任务的用量合计 */
export const helpersTokens = (task: Pick<Task, 'steps'>) => stepsTokens(helperSteps(task))

/** 一个对话自己的用量：它的累计去掉派出的子任务 */
export function ownTokens(task: Pick<Task, 'steps' | 'usage'>): TokenTotals {
  return subTokens(tokensOf(task.usage), helpersTokens(task))
}

/**
 * 一个对话连同它分出的所有子对话（含多层，按发现顺序）：第一个永远是它自己。
 * 用广度优先从 root 往下找，不依赖任务列表的顺序。
 */
export function runTree<T extends { id: string; parentTaskId?: string }>(root: T, all: T[]): T[] {
  const out = [root]
  const seen = new Set([root.id])
  for (let i = 0; i < out.length; i++) {
    for (const x of all) {
      if (x.parentTaskId !== out[i].id || seen.has(x.id)) continue
      seen.add(x.id)
      out.push(x)
    }
  }
  return out
}

/**
 * 一个任务连同它名下的全部后代（子对话、子对话的子对话……）的 id，不含祖先和兄弟。
 * 进程面板和内存统计按它算：「这个对话 + 它的附属」。用队列从起点往下找，
 * seen 里先放起点，脏数据里父子互相指向时也不会转不出来
 */
export function subtreeTaskIds(tasks: { id: string; parentTaskId?: string }[], id: string): Set<string> {
  const kids = new Map<string, string[]>()
  for (const x of tasks) {
    if (!x.parentTaskId || x.parentTaskId === x.id) continue
    const list = kids.get(x.parentTaskId)
    if (list) list.push(x.id)
    else kids.set(x.parentTaskId, [x.id])
  }
  const out = new Set([id])
  const queue = [id]
  while (queue.length) {
    for (const kid of kids.get(queue.shift()!) ?? []) {
      if (out.has(kid)) continue
      out.add(kid)
      queue.push(kid)
    }
  }
  return out
}

/**
 * 一组 Agent **现在**的输出速度：只算正在输出的那几条（CLI 那边 1.5 秒没有新输出就把 tps 清零）。
 * 不传 agentIds 就是任务里所有 Agent。
 *
 * 为什么不回退 lastTps：lastTps 是「这一轮最后一次的速度」，已经停下的子对话还留着它。
 * 拿它冒充实时速度会出现「什么都没在输出，浮层里还有 2041.7 token/s」，
 * 而且父对话那一层和子对话那一层回退的时机不一样（父对话每轮从 0 清），三层加起来就不一致了。
 * 已经结束的任务一律算 0：进程崩溃、面板重启前留下的 tps 不是「现在」的速度。
 */
export function tpsNow(task: Pick<Task, 'usage' | 'status'>, agentIds?: string[]) {
  if (task.status !== 'running') return 0
  const list = Object.entries(task.usage?.agents ?? {}).filter(([id]) => !agentIds || agentIds.includes(id))
  return list.reduce((n, [, u]) => n + (u.tps ?? 0), 0)
}

export type RunUsage = {
  /** 整个运行：父对话 + 所有子对话（含多层）+ 派出的子任务 */
  total: TokenTotals
  /** 当前父对话本身（不含子对话和它派出的子任务） */
  own: TokenTotals
  /** 子任务与子对话合计 = total − own */
  sub: TokenTotals
  /** 当前父对话本身的速度（token/s），没在输出就是 0 */
  tps: number
  /** 子任务与子对话的速度：只算正在输出的那几条，停下的不贡献速度 */
  subTps: number
  /** 整个运行的速度 = 本对话 + 在跑的子对话 + 在跑的子任务（三层都是实时值，加起来才一致） */
  runTps: number
  /** 子对话数（含多层）和派出的子任务数：都是 0、子任务也没有用量时界面不显示分组，退化成只显示总数 */
  children: number
  helpers: number
}

/**
 * 整个运行的用量。`all` 是全部任务（含子对话）：子对话不在任务列表接口里，调用方要自己拿全。
 * `root` 不在 `all` 里也行（执行中的任务用内存里那一份传进来，速度才是实时的）。
 */
export function runUsage(root: Task, all: Task[]): RunUsage {
  const byId = new Map(all.map((x) => [x.id, x]))
  byId.set(root.id, root)
  const tree = runTree(root, [...byId.values()])
  const kids = tree.filter((x) => x.id !== root.id)

  const helpers = helperSteps(root)
  const helperIds = new Set(helpers.map((s) => s.id))
  // 只在子任务里出现的角色才算子任务的速度；父子共用的角色算本对话（见文件头）
  const helperAgents = new Set<string>()
  for (const s of helpers) if (s.agentId) helperAgents.add(s.agentId)
  for (const s of root.steps) if (s.agentId && !helperIds.has(s.id)) helperAgents.delete(s.agentId)
  // 其余 Agent 都算本对话：自己的步骤用到的，以及根本没挂在节点上的（对话的一轮不是节点，
  // 子任务却会挂成 slot: sub，只按步骤分的话对话自己的速度会整个丢掉）
  const agentIds = Object.keys(root.usage?.agents ?? {})
  const ownIds = agentIds.filter((id) => !helperAgents.has(id))

  const ownTps = ownIds.length ? tpsNow(root, ownIds) : helperAgents.size ? 0 : tpsNow(root)
  const helperTps = helperAgents.size ? tpsNow(root, [...helperAgents]) : 0
  const childTps = kids.reduce((n, k) => n + tpsNow(k), 0)
  const subTps = helperTps + childTps

  const total = tree.reduce((acc, x) => addTokens(acc, tokensOf(x.usage)), NO_TOKENS)
  const own = ownTokens(root)
  return {
    total,
    own,
    sub: subTokens(total, own),
    tps: ownTps,
    subTps,
    runTps: ownTps + subTps,
    children: kids.length,
    helpers: helpers.length,
  }
}
