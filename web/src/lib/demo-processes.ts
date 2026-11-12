/** 演示的进程面板和内存曲线：稳定的假进程、关掉进程、内存历史和分析，从 demo-backend.ts 拆出来（文件行数上限） */
import {
  Project,
  Task,
  type TaskProcess,
  type TaskProcesses,
  type TaskMemoryHistory,
  type TaskMemoryAnalysis,
} from '@shared/schema'
import { runTree, subtreeTaskIds } from '@shared/run-usage'
import {
  TASK_MEMORY_ASK,
  clipReport,
  ownersOf,
  taskMemoryReport,
  taskMemoryTrend,
  taskTrendText,
} from '@shared/memory-analysis'
import { childRecordActive } from '@shared/children/row'
import { demoPendingJobs } from './demo-children'
import { live } from './demo-live'

/** 字符串散成稳定的数字：同一个对话每次打开看到同样的 pid，截图和验证都对得上 */
export function hashNum(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** 演示里「关掉了」的进程：只留在内存里，刷新页面重新出现 */
export const demoGone = new Map<string, Set<number>>()

export const MB = 1024 * 1024

export function demoProcesses(task: Task, tasks: Task[]): TaskProcesses {
  const now = Date.now()
  // 和正式后端一个口径：当前对话 + 它的附属，父对话和兄弟不出现
  const ids = subtreeTaskIds(tasks, task.id)
  const rootId = task.rootTaskId || task.id
  // 关掉的进程按整棵树记：pid 是按根任务生成的，父对话和子对话的面板看到的是同一个进程
  const gone = demoGone.get(rootId) ?? new Set<number>()
  const base = (hashNum(rootId) % 20000) + 30000
  const started = (x: Task) => {
    const at = Date.parse(x.runStartedAt || x.updatedAt || '')
    return Number.isFinite(at) ? at : now - 12 * 60_000
  }
  const rows: TaskProcess[] = []
  const push = (pid: number, o: Omit<TaskProcess, 'pid'>) => {
    if (!gone.has(pid)) rows.push({ pid, ...o })
  }
  const active = demoLive(task) ? 'running' : 'idle'
  const cliTitle = task.title
  push(base, {
    parentPid: null,
    command: `pi --print --mcp-config {"mcpServers":{"panel":{}}} 对话：${task.title}`,
    ownerTaskId: task.id,
    ownerTitle: cliTitle,
    startedAt: started(task),
    durationMs: now - started(task),
    rss: 168 * MB,
    status: active,
    kind: 'cli',
  })
  // CLI 自己起的子进程（MCP 桥接、shell）：正式后端也把它们算进这个对话
  push(base + 1, {
    parentPid: base,
    command: 'node /home/u/.agent-panel/cache/cli-run/demo/ask-mcp.mjs',
    ownerTaskId: task.id,
    ownerTitle: cliTitle,
    startedAt: started(task) + 1200,
    durationMs: now - started(task) - 1200,
    rss: 46 * MB,
    status: active,
    kind: 'child',
  })
  // 在干的附属任务（子对话、子对话的子对话）
  for (const kid of tasks.filter((x) => x.id !== task.id && ids.has(x.id) && demoLive(x)).slice(0, 3)) {
    const at = started(kid)
    push(base + 10 + tasks.indexOf(kid), {
      parentPid: null,
      command: `codex app-server 子对话：${kid.title}`,
      ownerTaskId: kid.id,
      ownerTitle: kid.title,
      startedAt: at,
      durationMs: now - at,
      rss: 92 * MB,
      status: 'running',
      kind: 'cli',
    })
  }
  // 任务已经结束、进程还留着的残留：演示「清理无效进程」用
  const orphanAt = now - 46 * 60_000
  push(base + 99, {
    parentPid: null,
    command: 'claude --mcp-config {"mcpServers":{"panel":{}}} 已结束的子任务',
    ownerTaskId: task.id,
    ownerTitle: '已结束的子任务',
    startedAt: orphanAt,
    durationMs: now - orphanAt,
    rss: 24 * MB,
    status: 'orphan',
    kind: 'cli',
  })
  const cliMemory = rows.reduce((sum, p) => sum + (p.rss ?? 0), 0)
  const serverMemory = (268 + Math.round(Math.sin(now / 240_000) * 6)) * MB
  return {
    sampledAt: now,
    processes: rows,
    cliMemory,
    serverMemory,
    // 面板自己的内存不计入对话合计
    totalMemory: cliMemory,
    unavailable: '',
  }
}

/** 演示任务算不算「还在跑」 */
export function demoLive(task: Task) {
  return task.working === true || live.has(task.id)
}

/**
 * 演示里这个对话的 CLI 进程算不算活着（对正式后端 `taskCliAlive` 的替代）。
 * 演示里没有真的进程：除了 `live` 登记，还得把「停在等下一句 / 这一轮还在跑」也算上——
 * 这两件事本身就意味着进程活着。`live` 只在本次页面加载里有效，刷新后就空了，
 * 只按它算会让存盘里明明 `awaitingUser: true` 的对话在刷新后变成「进程已经回收」，`childWait` 也就算不出 `next`
 */
export const demoCliAlive = (task: Task) => live.has(task.id) || task.working === true || task.awaitingUser === true

/**
 * 子对话还在运行（和正式后端的 activeChildren / childActive 一个口径）：在跑、等结果、等回答都算，不只看 working。
 * 演示里没有 startQueue 和收件箱，后台命令数按演示数据里的 jobs 算
 */
export const demoChildActive = (x: Task) => childRecordActive(x, demoPendingJobs(x))

export function demoKill(task: Task, pid: number) {
  const rootId = task.rootTaskId || task.id
  const set = demoGone.get(rootId) ?? new Set<number>()
  set.add(pid)
  demoGone.set(rootId, set)
  return { ok: true, pid, error: '' }
}

export function demoClean(task: Task, body: unknown, tasks: Task[]) {
  const panel = demoProcesses(task, tasks)
  const want = (body as { pids?: unknown } | undefined)?.pids
  const asked = Array.isArray(want) ? want.filter((x): x is number => Number.isInteger(x)) : []
  const orphans = panel.processes.filter((p) => p.status === 'orphan' && p.kind === 'cli')
  const targets = asked.length ? orphans.filter((p) => asked.includes(p.pid)) : orphans
  const rootId = task.rootTaskId || task.id
  const set = demoGone.get(rootId) ?? new Set<number>()
  for (const p of targets) set.add(p.pid)
  demoGone.set(rootId, set)
  return { killed: targets.map((p) => p.pid), skipped: [], gone: [] }
}

export function demoSuggest(task: Task, tasks: Task[]) {
  const orphans = demoProcesses(task, tasks).processes.filter((p) => p.status === 'orphan')
  return {
    suggestions: orphans.map((p) => ({ pid: p.pid, reason: `所属任务已经结束，进程还留着（${p.ownerTitle}）` })),
    text: '',
    error: '',
  }
}

export function demoMemory(task: Task, query: URLSearchParams): TaskMemoryHistory {
  const intervalMs = 30_000
  const capacity = 2000
  const now = Date.now()
  const base = hashNum(task.rootTaskId || task.id)
  const from = Number(query.get('from') ?? '')
  const to = Number(query.get('to') ?? '')
  const points: TaskMemoryHistory['points'] = []
  // 两小时、30 秒一点，够看清趋势也能验证左右拖动
  for (let i = 239; i >= 0; i--) {
    const t = Math.floor(now / intervalMs) * intervalMs - i * intervalMs
    if (Number.isFinite(from) && from > 0 && t < from) continue
    if (Number.isFinite(to) && to > 0 && t > to) continue
    const wave = Math.sin(t / 900_000 + (base % 7)) * 28 + Math.sin(t / 240_000) * 8
    const cli = Math.round((132 + wave) * MB)
    const server = Math.round((268 + Math.sin(t / 300_000 + 1) * 6) * MB)
    // 合计只算这个对话的 CLI；面板自己的内存单独给出，不混进来
    points.push({ t, server, cli, total: cli })
  }
  return { sampledAt: now, intervalMs, capacity, points }
}

/** 演示版的内存分析：和正式后端同一套口径（shared/memory-analysis.ts），数字来自演示数据 */
export function demoMemoryAnalysis(task: Task, tasks: Task[], projects: Project[]): TaskMemoryAnalysis {
  const history = demoMemory(task, new URLSearchParams())
  const points = history.points
  const panel = demoProcesses(task, tasks)
  const owners = ownersOf(panel.processes, task.id)
  const tree = runTree(task, tasks)
  const contexts = tree
    .map((x) => {
      let best = { context: 0, window: 0 }
      for (const u of Object.values(x.usage?.agents ?? {})) {
        if ((u.context ?? 0) > best.context) best = { context: u.context ?? 0, window: u.window ?? 0 }
      }
      return { id: x.id, title: x.title, ...best, self: x.id === task.id }
    })
    .filter((x) => x.context > 0)
  const project = projects.find((p) => p.id === task.projectId) ?? null
  const trend = taskMemoryTrend(points)
  const report = taskMemoryReport({
    task: { title: task.title, mode: task.mode, status: task.status },
    project: project ? { name: project.name, path: project.path } : null,
    points,
    intervalMs: history.intervalMs,
    panel: { cliMemory: panel.cliMemory, serverMemory: panel.serverMemory, unavailable: panel.unavailable },
    owners,
    tree: {
      tasks: tree.length,
      children: tree.length - 1,
      running: tree.filter((x) => x.status === 'running').length,
    },
    contexts,
  })
  return {
    sampledAt: Date.now(),
    intervalMs: history.intervalMs,
    report: clipReport(report),
    ask: TASK_MEMORY_ASK,
    cwd: project?.path ?? '',
    trend: trend?.trend ?? null,
    trendText: taskTrendText(trend),
    owners: owners.map(({ taskId, title, self, rss, count, counted }) => ({
      taskId,
      title,
      self,
      rss,
      count,
      counted,
    })),
    tree: {
      tasks: tree.length,
      children: tree.length - 1,
      running: tree.filter((x) => x.status === 'running').length,
    },
  }
}
