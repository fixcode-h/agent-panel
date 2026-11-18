import { Hono } from 'hono'
/**
 * 补排查的接口（设计稿「Bug 模式子对话体验」第 1 节，读写在 bug-probe.ts）：和诊断报告的确认一样，
 * 这里只记下来、返回交给子对话的话，页面再把它作为用户消息发过去（走普通的发消息），不另写一套投递
 */
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
import { bugProbeContract as C } from '../../shared/api-contract/bug-probe.ts'
import type { Task } from '../../shared/schema.ts'
import { removeProbes } from './bug-probe.ts'
import { retryProbe, startProbe } from '../../shared/bug/probe-start.ts'
import { readTask } from './read.ts'
import type { TasksScope } from './scope.ts'

export function probeRoutes(s: TasksScope): Hono {
  const app = new Hono()
  const save = async (task: Task) => {
    const entry = s.live.get(task.id)
    if (entry) entry.rev++
    task.updatedAt = new Date().toISOString()
    return (await s.store.update(task.id, task)) ?? task
  }

  app.post('/:id/bug-probe', async (c) => {
    const body = C.start.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const task = await readTask(s, c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.imported) return s.bad(c, s.READONLY, 409)
    const r = startProbe(task, body.data)
    if (!r.ok) return s.bad(c, r.error, 409)
    return c.json({ task: await save(task), message: r.message })
  })

  app.post('/:id/bug-probe-action', async (c) => {
    const body = C.action.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const task = await readTask(s, c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.imported) return s.bad(c, s.READONLY, 409)
    const r =
      body.data.action === 'retry'
        ? retryProbe(task, body.data.ids[0] ?? '')
        : await removeProbes(task, await s.taskDir(task).catch(() => ''), body.data.ids)
    if (!r.ok) return s.bad(c, r.error, 409)
    return c.json({ task: await save(task), message: r.message })
  })
  return app
}
