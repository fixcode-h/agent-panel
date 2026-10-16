import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  FollowUpInput,
  NewTaskInput,
  Task,
  type Agent,
  type Project,
  type ProjectCategory,
  type TaskData,
  type Workflow,
} from '../shared/schema.ts'
import { newTask, runTurn } from '../shared/runner.ts'
import { getSettings } from './settings.ts'
import { detectClis } from './detect.ts'
import { gitNumstat } from './exec/git.ts'
import { runRealTurn } from './exec/runner.ts'
import { createCollection } from './store.ts'

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 任务接口与执行。执行中的任务放在内存里，按节点落盘，避免流式输出时频繁写文件 */
export function tasksApi(deps: {
  agents: Lister<Agent>
  workflows: Lister<Workflow>
  projects: Lister<Project>
  projectCategories: Lister<ProjectCategory>
}) {
  const store = createCollection<TaskData, Task>('tasks.json', Task)
  const live = new Map<string, { task: Task; stop: boolean; abort: AbortController; done?: Promise<void> }>()

  // 服务重启时，之前没跑完的任务标记为已停止
  void store.list().then(async (all) => {
    for (const t of all.filter((t) => t.status === 'running'))
      await store.update(t.id, {
        ...t,
        status: 'stopped',
        steps: t.steps.map((s) => (s.status === 'running' ? { ...s, status: 'pending' } : s)),
      })
  })

  const current = async (id: string) => live.get(id)?.task ?? (await store.get(id))
  const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)

  async function projectWorkflow(p: Project) {
    const cat = p.categoryId ? await deps.projectCategories.get(p.categoryId) : null
    const id = p.workflowId || cat?.workflowId
    return id ? ((await deps.workflows.get(id)) ?? undefined) : undefined
  }

  async function start(task: Task, prompt: string, first: boolean, workflow: Workflow | undefined, agents: Agent[]) {
    const settings = await getSettings()
    const project = await deps.projects.get(task.projectId)
    const entry: { task: Task; stop: boolean; abort: AbortController; done?: Promise<void> } = {
      task: structuredClone(task),
      stop: false,
      abort: new AbortController(),
    }
    live.set(task.id, entry)
    // 先同步标成执行中，接口返回时页面就能开始轮询
    entry.task.status = 'running'
    let last = 0
    const flush = () => store.update(task.id, entry.task)
    const changed = (f?: boolean) => {
      entry.task.updatedAt = new Date().toISOString()
      // 流式输出时最多每秒落盘一次，关键节点立即落盘
      if (f || Date.now() - last > 1000) {
        last = Date.now()
        void flush()
      }
    }
    const simulate = settings.execution === 'simulate' || !project
    const run = simulate
      ? runTurn({
          task: entry.task,
          agents,
          workflows: await deps.workflows.list(),
          workflow,
          prompt,
          first,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          stopped: () => entry.stop,
          changed,
          newId: randomUUID,
        })
      : (async () => {
          const snapshot = await gitNumstat(project.path).catch(() => null)
          if (first) entry.task.baseline = snapshot ?? {}
          await runRealTurn({
            task: entry.task,
            agents,
            workflows: await deps.workflows.list(),
            workflow,
            project,
            settings,
            clis: await detectClis(),
            prompt,
            signal: entry.abort.signal,
            changed,
            newId: randomUUID,
            isGit: snapshot !== null,
          })
        })()
    entry.done = run
      .catch((e) => {
        entry.task.status = 'failed'
        entry.task.messages.push({
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: `执行出错：${(e as Error).message}`,
          tools: [],
          at: new Date().toISOString(),
        })
      })
      .finally(async () => {
        await flush()
        live.delete(task.id)
      })
    return entry.task
  }

  const stopTask = (id: string) => {
    const e = live.get(id)
    if (!e) return
    e.stop = true
    e.abort.abort()
  }

  const routes = new Hono()

  routes.get('/', async (c) => {
    const pid = c.req.query('projectId')
    const all = (await store.list()).map((t) => live.get(t.id)?.task ?? t)
    return c.json(pid ? all.filter((t) => t.projectId === pid) : all)
  })

  routes.get('/:id', async (c) => {
    const t = await current(c.req.param('id'))
    return t ? c.json(t) : bad(c, '任务不存在', 404)
  })

  routes.post('/', async (c) => {
    const p = NewTaskInput.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const input = p.data
    const project = await deps.projects.get(input.projectId)
    if (!project) return bad(c, '项目不存在', 404)
    const agents = await deps.agents.list()
    let workflow: Workflow | undefined
    if (input.mode === 'workflow') {
      workflow = input.workflowId
        ? ((await deps.workflows.get(input.workflowId)) ?? undefined)
        : await projectWorkflow(project)
      if (!workflow) return bad(c, '项目还没有指定工作流，请选择一个工作流或改用直接对话')
    } else if (!agents.some((a) => a.id === input.agentId)) return bad(c, '请选择对话的 Agent')
    const task = await store.create(newTask(input, workflow, new Date().toISOString(), randomUUID()))
    return c.json(await start(task, input.prompt, true, workflow, agents), 201)
  })

  routes.post('/:id/messages', async (c) => {
    const id = c.req.param('id')
    const p = FollowUpInput.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const prev = live.get(id)
    // 刚执行完、还在落盘的任务：等它写完再接着跑
    if (prev && prev.task.status !== 'running') await prev.done
    if (live.has(id)) return bad(c, '任务正在执行，请等它完成或先停止', 409)
    const task = await store.get(id)
    if (!task) return bad(c, '任务不存在', 404)
    const next: Task = structuredClone(task)
    next.messages.push({
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text: p.data.text,
      tools: [],
      at: new Date().toISOString(),
    })
    const workflow = next.workflowId ? ((await deps.workflows.get(next.workflowId)) ?? undefined) : undefined
    return c.json(await start(next, p.data.text, false, workflow, await deps.agents.list()))
  })

  routes.post('/:id/stop', async (c) => {
    const id = c.req.param('id')
    stopTask(id)
    return c.json(await current(id))
  })

  routes.delete('/:id', async (c) => {
    const id = c.req.param('id')
    stopTask(id)
    return (await store.remove(id)) ? c.body(null, 204) : bad(c, '任务不存在', 404)
  })

  return {
    routes,
    async removeByProject(projectId: string) {
      for (const t of (await store.list()).filter((t) => t.projectId === projectId)) {
        stopTask(t.id)
        await store.remove(t.id)
      }
    },
  }
}
