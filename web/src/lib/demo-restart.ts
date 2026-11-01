import type { Project, Task } from '@shared/schema'
import type { InterruptedTasks } from '@shared/version'
import { restartResumable } from '@shared/resume-kids'

/**
 * 在线演示里「被面板重启打断的对话」（首页的「全部继续」，从 demo-backend.ts 拆出来，那个文件有行数上限）。
 * 演示不会真的重启：停止原因写着「面板重启」的顶层对话都算，种子数据里没有，界面检查改演示数据造一条
 */
let acked = false
export function demoRestart(d: { tasks?: Task[]; projects: Project[] }, url: string): InterruptedTasks {
  if (url.endsWith('/ack')) acked = true
  const name = (id: string) => d.projects.find((p) => p.id === id)?.name ?? ''
  const tasks = acked
    ? []
    : (d.tasks ?? []).filter(restartResumable).map((x) => ({
        id: x.id,
        title: x.title,
        projectId: x.projectId,
        projectName: x.projectId ? name(x.projectId) : '',
        doing: '',
      }))
  return { at: '', acknowledged: acked, tasks }
}
