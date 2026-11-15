import type { Task } from '@shared/schema'
import type { TaskLive } from '@shared/live/task-live'
import { liveBusy } from '@shared/live/task-live'

/** 一个项目在侧栏、项目下拉、全部项目页上显示的状态：执行中几个、有没有在等你处理的、一共几个对话 */
export interface ProjectStat {
  running: number
  needs: number
  count: number
}

/**
 * 按项目汇总对话状态。状态只读服务端给的 live（和对话行同一份）：子对话在等你确认时父对话也是「等你处理」。
 * tasks 传侧栏列的那批（没归档、不含子对话和插件管的对话）
 */
export function projectStats(tasks: Task[], liveOf: (t: Task) => Pick<TaskLive, 'state'>) {
  const out = new Map<string, ProjectStat>()
  for (const tk of tasks) {
    const s = out.get(tk.projectId) ?? { running: 0, needs: 0, count: 0 }
    const live = liveOf(tk)
    s.count++
    if (liveBusy(live)) s.running++
    if (live.state === 'needs') s.needs++
    out.set(tk.projectId, s)
  }
  return out
}

export const EMPTY_STAT: ProjectStat = { running: 0, needs: 0, count: 0 }
