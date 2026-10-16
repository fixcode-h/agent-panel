import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Project, Task } from '@shared/schema'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { ProjectDetail } from '@/components/projects/ProjectDetail'
import { NewTask } from './NewTask'
import { TaskListPane } from './TaskListPane'
import { TaskView } from './TaskView'

/** 点进一个项目后的工作区：左边任务列表，中间任务对话或新建任务，设置在齿轮里 */
export function ProjectWorkspace({ project, sub, onDuplicate }: { project: Project; sub?: string; onDuplicate: () => void }) {
  const { go } = useNav()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const open = (s?: string) => go({ page: 'projects', id: project.id, sub: s })

  const load = () =>
    api
      .tasks(project.id)
      .then(setTasks)
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  useEffect(() => {
    load()
  }, [project.id])

  // 列表里有执行中的任务时定期刷新状态
  const anyRunning = tasks.some((t) => t.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [anyRunning, project.id])

  // 没有指定时：打开最近的任务，没有任务就进入新建
  const latest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const current = sub ?? (loading ? undefined : (latest?.id ?? 'new'))
  const upsert = (t: Task) => setTasks((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t]))

  return (
    <>
      <TaskListPane
        project={project}
        tasks={tasks}
        loading={loading}
        selected={current ?? ''}
        onSelect={open}
        onBack={() => go({ page: 'projects' })}
      />
      {current === 'settings' ? (
        <ProjectDetail project={project} onDuplicate={onDuplicate} onDeleted={() => go({ page: 'projects' })} />
      ) : current === 'new' ? (
        <NewTask
          project={project}
          onCreated={(t) => {
            upsert(t)
            open(t.id)
          }}
        />
      ) : current ? (
        <TaskView
          key={current}
          taskId={current}
          project={project}
          onChange={upsert}
          onDeleted={() => {
            setTasks((ts) => ts.filter((t) => t.id !== current))
            open(undefined)
          }}
        />
      ) : null}
    </>
  )
}
