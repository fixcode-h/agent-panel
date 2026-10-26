import type { StopReason, Task } from '../../shared/schema.ts'
import { restartInterrupted } from '../../shared/task.ts'
import { log } from '../log.ts'

/** 收口只需要这两个动作：读一条任务、写回它 */
type ReclaimStore = {
  get(id: string): Promise<Task | null>
  update(id: string, task: Task): Promise<Task | null>
}

/**
 * 页面宽限到了、CLI 也回收了：把界面还会画成在跑、实际已经没人在做的任务收口成已停止。
 *
 * 要收口的有两种：
 * - 落盘还写着 `running`（「等下一句」）：CLI 回收后状态没跟着落，列表一直转圈、还算进「N 个执行中」；
 * - 落盘已经是 `done`，但计划没做完 / 独立分支没合回（`restartInterrupted`）：界面按 unfinished 画成在跑。
 * 两种都会让用户看到「转圈 + CLI 进程已回收」，而「继续执行」只在 stopped 时出现，等于没有入口
 * （用户报的现象：一批子对话停在未完成、进程早没了、很多子对话没有拉起）。
 *
 * 不碰的：正在执行的（`working`）、已经停下的（用户暂停、父对话结束…原因不能覆盖）、
 * 以及一轮做完、没有挂起事项的（它就该是 done，预热退出不算中断）。
 */
export async function settleReclaimed(store: ReclaimStore, id: string, reason: StopReason): Promise<boolean> {
  const tk = await store.get(id).catch(() => null)
  if (!tk || tk.working) return false
  const unfinished = restartInterrupted(tk)
  if (tk.status !== 'running' && !unfinished) return false
  await store
    .update(id, {
      ...tk,
      status: 'stopped',
      stopReason: reason,
      working: false,
      awaitingUser: false,
      prewarming: false,
    })
    .catch((e) => log.warn('task', '收口回收掉的任务失败', { task: id, error: (e as Error).message }))
  return true
}
