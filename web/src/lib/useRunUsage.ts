import { useEffect, useState } from 'react'
import type { Task } from '@shared/schema'
import { runUsage, type RunUsage } from '@shared/run-usage'
import { helpersWorking } from '@shared/task'
import { api } from './api'

/**
 * 整个运行的用量：父对话 + 所有子对话（含多层）+ 派出的子任务。
 *
 * 为什么问服务端：任务列表接口不返回子对话（`parentTaskId` 的都被过滤掉），前端拿不到它们的用量。
 * 执行中每秒问一次（子对话、子任务的速度是实时的），跑完状态一变再问一次拿最终的数；
 * 屏幕上的数字每秒刷一次可以接受，跟着流式推送每条都问会把接口刷爆。
 * enabled 为 false 时不查（流程图里选了节点时只看那个节点）。
 */
export function useRunUsage(task: Task, enabled = true): RunUsage {
  const [fetched, setFetched] = useState<{ id: string; run: RunUsage } | null>(null)
  // 什么时候要重新查：执行状态、这一轮结束、名下有没有子对话
  const key = `${task.status}:${task.working}:${task.childrenWorking ?? 0}:${task.turnDoneAt ?? ''}`
  const busy = task.status === 'running' || !!task.working || !!task.childrenWorking || helpersWorking(task)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () =>
      api
        .taskRunUsage(task.id)
        .then((run) => alive && setFetched({ id: task.id, run }))
        // 查不到就退成本任务自己算的那份，不挡住其它信息
        .catch(() => alive && setFetched(null))
    void load()
    if (!busy) return () => void (alive = false)
    // 标签页在后台时不问：多开几个标签页时后台的也每秒打一次接口
    const timer = setInterval(() => !document.hidden && load(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // task 只用到 id 和上面这个指纹：流式输出每 200ms 换一个对象，按对象重新查会把接口刷爆
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, key, enabled])
  // 换了一个任务、或者还没查回来：先用本任务自己算的那份（子对话的数字会晚一秒）
  return fetched?.id === task.id ? fetched.run : runUsage(task, [task])
}
