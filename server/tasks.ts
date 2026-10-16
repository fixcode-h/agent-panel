import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  FollowUpInput,
  TaskPatch,
  NewTaskInput,
  Task,
  type Agent,
  type Project,
  type ProjectCategory,
  type TaskData,
  type Workflow,
} from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
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
  type Live = { task: Task; stop: boolean; abort: AbortController; done?: Promise<void> }
  const live = new Map<string, Live>()
  /** 同步占住任务的执行位，避免两次请求在 await 的间隙里各自启动一遍 */
  const reserve = (task: Task): Live => {
    const entry: Live = { task: structuredClone(task), stop: false, abort: new AbortController() }
    live.set(task.id, entry)
    return entry
  }

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

  async function start(entry: Live, prompt: string, first: boolean, workflow: Workflow | undefined, agents: Agent[]) {
    const task = entry.task
    // 先标成执行中，接口返回时页面就能开始轮询
    entry.task.status = 'running'
    const [settings, project] = await Promise.all([getSettings(), deps.projects.get(task.projectId)]).catch((e) => {
      live.delete(task.id)
      throw e
    })
    let last = 0
    const flush = () =>
      store.update(task.id, entry.task).catch((e) => console.error(`保存任务失败：${(e as Error).message}`))
    const changed = (f?: boolean) => {
      entry.task.updatedAt = new Date().toISOString()
      // 流式输出时最多每秒落盘一次，关键节点立即落盘
      if (f || Date.now() - last > 1000) {
        last = Date.now()
        void flush()
      }
    }
    const run = (async () => {
      // 项目被删掉后任务还在，这时没有目录可以执行
      if (!project) throw new Error('任务所属的项目已经不存在')
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
    return c.json(await start(reserve(task), input.prompt, true, workflow, agents), 201)
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
    const entry = reserve(task)
    const next = entry.task
    next.messages.push({
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text: p.data.text,
      tools: [],
      at: new Date().toISOString(),
    })
    try {
      const workflow = next.workflowId ? ((await deps.workflows.get(next.workflowId)) ?? undefined) : undefined
      return c.json(await start(entry, p.data.text, false, workflow, await deps.agents.list()))
    } catch (e) {
      live.delete(id)
      throw e
    }
  })

  // 失败或停止后继续：不加新消息，从没完成的节点接着跑；工作流已完成时重做最后一条要求
  routes.post('/:id/resume', async (c) => {
    const id = c.req.param('id')
    const prev = live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (live.has(id)) return bad(c, '任务正在执行', 409)
    const task = await store.get(id)
    if (!task) return bad(c, '任务不存在', 404)
    if (task.status !== 'failed' && task.status !== 'stopped') return bad(c, '只有失败或停止的任务可以继续')
    const entry = reserve(task)
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    try {
      const workflow = task.workflowId ? ((await deps.workflows.get(task.workflowId)) ?? undefined) : undefined
      return c.json(await start(entry, users.at(-1)?.text ?? '', false, workflow, await deps.agents.list()))
    } catch (e) {
      live.delete(id)
      throw e
    }
  })

  routes.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const p = TaskPatch.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const e = live.get(id)
    if (e) {
      Object.assign(e.task, p.data)
      return c.json(e.task)
    }
    const task = await store.get(id)
    if (!task) return bad(c, '任务不存在', 404)
    return c.json(await store.update(id, { ...task, ...p.data }))
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
    /** 服务退出前停掉所有正在跑的 CLI，免得它们在后台继续改项目 */
    stopAll() {
      for (const id of live.keys()) stopTask(id)
      return Promise.allSettled([...live.values()].map((e) => e.done))
    },
    async removeByProject(projectId: string) {
      for (const t of (await store.list()).filter((t) => t.projectId === projectId)) {
        stopTask(t.id)
        await store.remove(t.id)
      }
    },
  }
}
