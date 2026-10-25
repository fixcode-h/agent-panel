import { useEffect, useState } from 'react'
import type { TaskJob, TaskJobView } from '@shared/schema'
import { api } from '@/lib/api'
import { mergeJobView, nextPollMs, type JobViewState } from '@/lib/job-poll'
import { CommandDialog, type CommandPhase } from './ToolDialog'

/**
 * 窗口要显示哪条后台命令：id + 打开那一刻行上的信息（命令、状态）。
 * 打开入口在运行区那一行上，但窗口挂在任务页顶层（见 JobOpenCtx）：命令跑完那一行会从运行区消失，
 * 窗口跟着行一起卸载的话，用户正好看不到这次最要看的最终输出
 */
export interface JobTarget {
  id: string
  /** 行上的命令原文：第一次拉回来之前用它先把窗口画出来 */
  command: string
  /** 行上的状态：同上，还没拉到数据时按它显示（排队中的先显示「排队中，还没有输出」） */
  state: TaskJob['state']
  startedAt: string
}

/**
 * 后台命令行点标题打开的命令行窗口：和工具行的命令窗口是同一个（CommandDialog），
 * 区别只在输出要按 jobId 自己拉——命令跑在服务端，输出不进对话记录。
 *
 * 打开时先拉一次（用户可能过一阵才点开，那时命令已经跑完了），还在跑就接着拉；
 * 拉失败按 JOB_RETRY_MS 重试，并保留上一次读到的输出（不清空）。
 */
export function JobDialog({
  taskId,
  target,
  onOpenChange,
}: {
  taskId: string
  /** 为 null 表示没打开；关掉时保留最后一次的输出，下次打开同一个 id 还能接着看 */
  target: JobTarget | null
  onOpenChange: (open: boolean) => void
}) {
  // 每个 id 的最近一份结果和错误：换了一条命令不会串，关掉再打开还能看到上一次读到的内容
  const [seen, setSeen] = useState<JobViewState>({ id: '', view: null, error: '' })
  const id = target?.id ?? ''
  const mine = seen.id === id
  const view = mine ? seen.view : null
  const error = mine ? seen.error : ''

  useEffect(() => {
    if (!target) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 链式 setTimeout 而不是 setInterval：上一次还没回来就不叠加下一次，网络慢时不会攒一串请求
    const tick = async () => {
      let next: TaskJobView | null = null
      let why = ''
      try {
        next = await api.taskJob(taskId, target.id)
      } catch (e) {
        // 读不到就把真实原因留在窗口里：不能显示成「没有输出」，也不能当作命令还在跑
        why = (e as Error).message
      }
      if (stopped) return
      // 失败时保留上一次读到的输出（不清空），错误单独显示在输出上方
      setSeen((prev) => mergeJobView(prev, target.id, next, why))
      // 失败不是终态，接着重试；只有真的读到终态（done / failed / stopped）才停
      const wait = nextPollMs(next)
      if (wait !== undefined) timer = setTimeout(tick, wait)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [taskId, target])

  if (!target) return null
  // 命令还没拉回来时按行上那份状态画：排队中的先显示「排队中，还没有输出」，不显示成完成
  const phase: CommandPhase = view?.state ?? target.state
  return (
    <CommandDialog
      command={view?.command || target.command}
      output={view?.output ?? ''}
      status={phase}
      code={view?.code}
      error={error}
      startedAt={
        view?.startedAt ? Date.parse(view.startedAt) : target.startedAt ? Date.parse(target.startedAt) : undefined
      }
      open
      onOpenChange={onOpenChange}
    />
  )
}
