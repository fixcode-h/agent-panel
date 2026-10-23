import { Hono, type Context } from 'hono'
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os'
import { getHeapStatistics } from 'node:v8'
import type { Task, TaskMemoryAnalysis, TaskProcesses } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'
import { formatBytes } from '../shared/memory.ts'
import {
  TASK_MEMORY_ASK,
  TASK_MEMORY_TOPIC,
  clipReport,
  ownersOf,
  taskMemoryBrief,
  taskMemoryReport,
  taskMemoryTrend,
  taskTrendText,
  type TaskContext,
} from '../shared/memory-analysis.ts'
import { runTree } from '../shared/run-usage.ts'
import { SAMPLE_INTERVAL_MS, loadHistory, summarize, type StoredSample } from './exec/proc-stats.ts'
import { registerFixTopic } from './fix.ts'

/**
 * 会话内存的 AI 分析：把「这个会话的采样序列 + 进程面板的两路占用 + 任务树规模 + 上下文占用」
 * 整理成一段报告，界面拿去交给本机 CLI（见 web/src/components/tasks/MemoryChart.tsx 的「AI 分析」）。
 *
 * 单独成一个接口文件（和 run-usage.ts 一样）：tasks.ts 的路由已经很大，聚合口径在
 * shared/memory-analysis.ts，这里只负责取数；进程面板那两路复用 tasks.ts 的 processPanel，
 * 保证界面上看到的数字和交给 AI 的是同一份。
 */

/** 报告只取最近这么多点（约两小时）：趋势判断用不到更早的，报告也不会太长 */
const MAX_POINTS = 240

const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** 一个任务自己的上下文占用：取它用量里最大的那个 Agent（同一轮里只有主 Agent 在涨） */
function contextOf(tk: Task): { context: number; window: number } {
  let best = { context: 0, window: 0 }
  for (const u of Object.values(tk.usage?.agents ?? {})) {
    const context = num(u.context)
    if (context > best.context) best = { context, window: num(u.window) }
  }
  return best
}

export function taskMemoryApi(deps: {
  tasks: {
    get(id: string): Promise<Task | null>
    peek(id: string): Promise<Task | null>
    list(): Promise<Task[]>
  }
  /** 这个会话的进程面板（含两路占用和每行的归属），和界面上的进程列表同源 */
  panel(id: string): Promise<TaskProcesses | null>
  projects: { get(id: string): Promise<{ name: string; path: string } | null> }
  /** 采样历史（测试里换一份；正常用法是 server/exec/proc-stats.ts 落的盘） */
  history?: () => StoredSample[]
}) {
  const routes = new Hono()
  const bad = (c: Context, error: string) => c.json({ error }, 400)

  routes.get('/:id/memory-analysis', async (c) => {
    const id = c.req.param('id')
    const tk = await deps.tasks.get(id)
    if (!tk) return bad(c, t('任务不存在'))
    try {
      const rootId = tk.rootTaskId || tk.id
      const panel = await deps.panel(id)
      // 和内存曲线用同一份历史、同一个 rootId：曲线上的两条线就是报告里说的那两个数
      const points = summarize((deps.history ?? loadHistory)(), rootId).slice(-MAX_POINTS)
      const tree = runTree(tk, await deps.tasks.list())
      const kids = tree.filter((x) => x.id !== tk.id)
      const running = tree.filter((x) => x.status === 'running').length
      const contexts: TaskContext[] = tree
        .map((x) => ({ x, ...contextOf(x) }))
        .filter((x) => x.context > 0)
        .map((x) => ({ id: x.x.id, title: x.x.title, context: x.context, window: x.window, self: x.x.id === tk.id }))
      const project = tk.projectId ? await deps.projects.get(tk.projectId).catch(() => null) : null
      const processes = panel?.processes ?? []
      const owners = ownersOf(processes, tk.id)
      const trend = taskMemoryTrend(points)
      const report = taskMemoryReport({
        task: { title: tk.title, mode: tk.mode, status: tk.status },
        project: project ? { name: project.name, path: project.path } : null,
        points,
        intervalMs: SAMPLE_INTERVAL_MS,
        panel: {
          cliMemory: panel?.cliMemory ?? null,
          serverMemory: panel?.serverMemory ?? 0,
          unavailable: panel?.unavailable ?? '',
        },
        owners,
        tree: { tasks: tree.length, children: kids.length, running },
        contexts,
      })
      const body: TaskMemoryAnalysis = {
        sampledAt: Date.now(),
        intervalMs: SAMPLE_INTERVAL_MS,
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
        tree: { tasks: tree.length, children: kids.length, running },
      }
      return c.json(body)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  return { routes }
}

/**
 * 「AI 分析」的补充情况：这台机器的运行环境，以及这次体检要按什么顺序回答。
 * 采样和归属的数字由界面在 FixInput.context 里带上（那是这次会话的真实数据，topic 拿不到任务 id）。
 */
registerFixTopic(TASK_MEMORY_TOPIC, {
  context: () => {
    const heap = getHeapStatistics()
    return [
      taskMemoryBrief(),
      '',
      `运行环境：Node ${process.version}（V8 堆上限 ${formatBytes(heap.heap_size_limit)}），${platform()} ${release()} ${arch()}，${cpus().length} 核，物理内存 ${formatBytes(totalmem())}。`,
      `内存采样：每 ${Math.round(SAMPLE_INTERVAL_MS / 1000)} 秒一次，保留约 16 小时；交付给这次分析的报告由面板按当前会话现算，没有写死的数字。`,
      `相关目录：项目路径写在报告里；找不到项目时用用户目录 ${homedir()}。`,
    ].join('\n')
  },
})
