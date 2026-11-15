import type { ChildFlowStop } from '../../../shared/task.ts'
import type { ChildCounts } from '../../../shared/children/row.ts'
import type { MergeStall } from '../../../shared/merge-stall.ts'
import type { createDrive } from '../drive.ts'
import type { TasksScope } from '../scope.ts'

/**
 * 子对话生命周期各块（计数 count.ts、上报 report.ts、停止 stop.ts、完成 complete.ts、一轮结束 turn-end.ts、
 * 启动 start.ts、规则 rule.ts）共享的状态，由 createChildren（index.ts）建一份显式传进去。
 * 以前这些都是 createChildren 闭包里的 let / Map，700 行里谁读谁写看不出来；收进这里后每个字段写明读写方。
 */
export interface ChildrenCtx {
  sc: TasksScope
  /** 一轮结束时的推进（自驱，ADR 0041，drive.ts）：turn-end.ts 用 nudgePlan */
  drive: ReturnType<typeof createDrive>
  /**
   * 父对话已经收到「子对话已完成」上报的子对话。只在进程里记：重启后把已经置完成（resolved）的当作上报过了，
   * 不重复往父对话里刷同一条「已完成」。写：complete.ts（advanceChildTo 的上报、退回未合并时删）；也交给 merge 等调用方
   */
  reportedDone: Set<string>
  /** 上次交给父对话的状态（见 reportChild）：同一个状态不重复报。写：report.ts、complete.ts（quiet 上报） */
  reportedState: Map<string, string>
  /** 子对话停在「只剩合回、没请收尾」的次数（见 nextMergeStall）：离开这个状态就清掉。读写只在 report.ts */
  mergeStalls: Map<string, MergeStall>
  /**
   * 正在做的「彻底完成」：删独立分支的目录和分支、清后台命令。
   * 继续执行（追加要求）要等它结束再重建目录：收尾和重建撞在一起时，刚重建起来的分支可能又被这次收尾删掉
   * （测试里表现为刚重建的分支状态又变回「已合并」）。并发的两次收尾共用同一次，不重复删。
   * 写：complete.ts 的 completeChildOnce；也交给调用方等它
   */
  completing: Map<string, Promise<void | ChildFlowStop>>
  /** 名下子对话计数的缓存（见 count.ts 的 childCountsOf）：读写只在 count.ts */
  counts: { scan: { at: number; counts: (parentId: string) => ChildCounts } | null }
}
