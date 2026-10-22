import type { AgentUsage, StepUsage, Task, TaskStep } from './schema.ts'

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
 * 一组 Agent 现在的速度之和：正在输出时用 tps，都没有输出时用这一轮最后一次的 lastTps。
 * 不传 agentIds 就是任务里所有 Agent。
 */
export function liveTps(task: Pick<Task, 'usage'>, agentIds?: string[]) {
  const list = Object.entries(task.usage?.agents ?? {}).filter(([id]) => !agentIds || agentIds.includes(id))
  const live = list.reduce((n, [, u]) => n + (u.tps ?? 0), 0)
  return live > 0 ? live : list.reduce((n, [, u]) => n + ((u as AgentUsage).lastTps ?? 0), 0)
}

export type RunUsage = {
  /** 整个运行：父对话 + 所有子对话（含多层）+ 派出的子任务 */
  total: TokenTotals
  /** 当前父对话本身（不含子对话和它派出的子任务） */
  own: TokenTotals
  /** 子任务与子对话合计 = total − own */
  sub: TokenTotals
  /** 当前父对话本身的速度（token/s） */
  tps: number
  /** 整个运行的速度：父对话 + 在跑的子对话 + 在跑的子任务 */
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
  const ownAgents = new Set<string>()
  for (const s of root.steps) if (s.agentId && !helperIds.has(s.id)) ownAgents.add(s.agentId)
  // 只在子任务里出现的角色才算子任务的速度；父子共用的角色算本对话（见文件头）
  const helperAgents = new Set<string>()
  for (const s of helpers) if (s.agentId && !ownAgents.has(s.agentId)) helperAgents.add(s.agentId)

  const ownTps = helperAgents.size ? liveTps(root, [...ownAgents]) : liveTps(root)
  const helperTps = helperAgents.size ? liveTps(root, [...helperAgents]) : 0
  const childTps = kids.reduce((n, k) => n + liveTps(k), 0)

  const total = tree.reduce((acc, x) => addTokens(acc, tokensOf(x.usage)), NO_TOKENS)
  const own = ownTokens(root)
  return {
    total,
    own,
    sub: subTokens(total, own),
    tps: ownTps,
    runTps: ownTps + helperTps + childTps,
    children: kids.length,
    helpers: helpers.length,
  }
}
