import type { Task } from '../../../shared/schema.ts'
import { hasHeld } from '../../exec/delivery.ts'
import { childCountsScan, childRecordActive } from '../../../shared/children/row.ts'
import { taskCliAlive } from '../../exec/process.ts'
import { freshTask } from '../read.ts'
import type { TasksScope } from '../scope.ts'
import type { ChildrenCtx } from './context.ts'

/**
 * 子对话还在运行（见 convActive）：在跑、等结果、等回答、正在启动，或者还有交过来的消息要接着处理。
 * 父对话的「子对话在跑」计数、标题和侧栏的转圈、能不能回收都读它
 */
export const childActive = (sc: TasksScope, tk: Task) =>
  sc.startQueue.has(tk.id) || hasHeld(tk.id) || childRecordActive(tk, sc.pendingJobs(tk.id))

/**
 * 名下有还在运行的子对话（见 childActive）几个：父对话的计数、保活回收都读它，不在各处再拼一遍。
 * 只数执行位里的：闲着的子对话不用护着父对话（回收父对话不会连带停下它，结果也会走 wakeConv 交回）。
 * startQueue 里的子对话不用单独数：startChild 的 add 到 reserve 之间没有 await，外部观察不到那一段
 */
export function childrenRunning(sc: TasksScope, parentId: string): number {
  return [...sc.live.values()].filter((e) => e.task.parentTaskId === parentId && childActive(sc, e.task)).length
}

/**
 * 名下子对话的计数（还在跑的、CLI 还活着的）：一次 store.list() 把所有父对话的都算出来，
 * 结果留 1 秒。SSE 对每个打开的对话每秒问一次、执行中的对话每 200ms 就先算一次，
 * 不缓存的话父对话开得越多，每秒扫整份任务列表的次数越多（每个父对话 2 次）
 */
const CHILD_COUNT_TTL = 1000
export async function childCountsOf(ctx: ChildrenCtx, parentId: string) {
  const { sc } = ctx
  const now = Date.now()
  if (!ctx.counts.scan || now - ctx.counts.scan.at >= CHILD_COUNT_TTL) {
    // 执行中的对话以内存里那份为准：请求刚弹出来还没落盘时，父对话也要马上变成「等你处理」
    const all = (await sc.store.list()).map((k) => freshTask(sc, k))
    // 和任务列表、演示后端同一份扫法（shared/children/row.ts）
    ctx.counts.scan = {
      at: now,
      counts: childCountsScan(all, { active: (k) => childActive(sc, k), cliAlive: (k) => taskCliAlive(k.id) }),
    }
  }
  const c = ctx.counts.scan.counts(parentId)
  return { working: c.childrenWorking, cli: c.childrenCli, needs: c.childrenNeeds }
}

/** 名下还在运行的子对话数（见 childActive） */
export async function activeChildren(ctx: ChildrenCtx, parentId: string) {
  return (await childCountsOf(ctx, parentId)).working
}

/** 名下 CLI 进程还活着的子对话数：标题流光、侧栏提示用（见 taskCliAlive） */
export async function cliChildren(ctx: ChildrenCtx, parentId: string) {
  return (await childCountsOf(ctx, parentId)).cli
}
