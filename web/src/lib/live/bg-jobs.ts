/**
 * 后台作业（ADR 0075）：侧栏底部的作业状态和列表共用。先取一次，之后跟着服务端推送的 bg-jobs 事件走，不轮询。
 * 演示版没有推送通道：演示后端在页面里发同名的窗口事件（web/src/lib/demo/demo-bg-jobs.ts）
 */
import { useEffect, useState } from 'react'
import { bgJobsContract as C } from '@shared/api-contract/bg-jobs'
import { sortJobs, type BgJob } from '@shared/jobs/types'
import { call } from '@/lib/api/call'
import { openPageStream } from './page-stream'

const demo = !!import.meta.env.VITE_DEMO
export const DEMO_BG_JOBS_EVENT = 'agent-panel:bg-jobs'

export function useBgJobs() {
  const [jobs, setJobs] = useState<BgJob[]>([])
  useEffect(() => {
    let alive = true
    const take = (list: BgJob[]) => alive && setJobs(sortJobs(list))
    call(C.list)
      .then((r) => take(r.jobs))
      .catch(() => undefined)
    if (demo) {
      const h = (e: Event) => take((e as CustomEvent<{ jobs: BgJob[] }>).detail.jobs)
      window.addEventListener(DEMO_BG_JOBS_EVENT, h)
      return () => {
        alive = false
        window.removeEventListener(DEMO_BG_JOBS_EVENT, h)
      }
    }
    const stream = openPageStream()
    stream.on('bg-jobs', (e) => {
      try {
        take((JSON.parse(e.data) as { jobs: BgJob[] }).jobs)
      } catch {
        // 坏的一条推送不影响下一条
      }
    })
    return () => {
      alive = false
      stream.close()
    }
  }, [])
  return [jobs, setJobs] as const
}

/**
 * 一组后台作业的「变化签名」：状态、阶段、进度变了它就变。页面自己的状态（模型列表、安装状态）
 * 跟着它重取一次，作业在跑时不用再自己 1 秒轮询一遍（推送本来就到了）
 */
export function useBgJobsKey(pick: (j: BgJob) => boolean) {
  const [jobs] = useBgJobs()
  return jobs
    .filter(pick)
    .map((j) => `${j.id}:${j.status}:${j.phase ?? ''}:${j.done ?? ''}`)
    .join('|')
}
