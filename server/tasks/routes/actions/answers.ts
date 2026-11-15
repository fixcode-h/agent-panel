import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RequestAnswer } from '../../../../shared/schema.ts'
import { trackWait } from '../../../../shared/task.ts'
import { answerRequest } from '../../../exec/requests.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'

/** 回答：子对话交给父对话决定的提问、Agent 的权限确认和提问 */
export function answerRoutes(s: TasksScope): Hono {
  const app = new Hono()
  // 回答子对话交给父对话决定的提问：直接把决定交给子对话，或者交给父对话的 AI 决定
  app.post('/:id/child-asks/:mid', async (c) => {
    const body = z
      .object({ answer: z.string().default(''), delegate: z.boolean().default(false) })
      .safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const answer = body.data.answer.trim()
    if (!answer && !body.data.delegate) return s.bad(c, t('回答是空的'))
    const r = await s.answerChildAsk(c.req.param('id'), c.req.param('mid'), answer, body.data.delegate)
    if ('error' in r) return s.bad(c, r.error ?? '')
    // 带上 nudge：交给父对话决定时到底叫没叫起来，界面据此显示结果或原因（不能只写日志）
    return c.json({ task: r.task, nudge: 'nudge' in r ? r.nudge : undefined })
  })

  // 回答 Agent 的请求：允许 / 拒绝一个操作，或者回答问题
  app.post('/:id/requests/:rid', async (c) => {
    const e = s.live.get(c.req.param('id'))
    const body = RequestAnswer.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    if (!e || !answerRequest(e.task, c.req.param('rid'), body.data, randomUUID))
      return s.bad(c, t('这个请求已经结束了'), 404)
    e.task.updatedAt = new Date().toISOString()
    trackWait(e.task)
    await s.store.update(e.task.id, e.task)
    return c.json(e.task)
  })
  return app
}
