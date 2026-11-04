/**
 * Bug 诊断报告的确认（ADR 0045）：用户在审阅弹窗里确认方案或标出疑问。
 * 只记决定、收起等确认的请求，返回交给子对话的话；页面再把这段话作为用户消息发给子对话（走普通的发消息，
 * 在跑、在等下一句、停着都由那条路处理），这里不另写一套投递
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
import { decideDiagnosis } from '../../shared/bug-diagnosis.ts'
import { DiagnosisNote } from '../../shared/bug-diagnosis-schema.ts'
import type { TasksScope } from './scope.ts'

const Decision = z.object({
  approve: z.boolean(),
  /** 用户点了「取消」：这次不修，计划收口、对话等下一句（不返回要交给子对话的话） */
  cancel: z.boolean().default(false),
  notes: z
    .array(DiagnosisNote.omit({ id: true }))
    .max(50)
    .default([]),
  overall: z.string().max(4000).default(''),
})

export function registerDiagnosisRoutes(s: TasksScope) {
  s.routes.post('/:id/diagnosis/:version', async (c) => {
    const id = c.req.param('id')
    const body = Decision.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const entry = s.live.get(id)
    // 诊断报告不挂在 CLI 进程上：子对话停着、不在内存里也能确认，改完落盘
    const task = entry?.task ?? (await s.store.get(id))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    // 取消要收口计划：它在回复（等确认期间用户又发了话）时会和这一轮抢着写，等它停下再取消
    if (body.data.cancel && task.working) return s.bad(c, t('它正在回复，等这一轮结束再取消'), 409)
    const r = decideDiagnosis(task, Number(c.req.param('version')), body.data, randomUUID)
    if (!r.ok) return s.bad(c, r.error, 409)
    if (body.data.cancel) task.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    const saved = await s.store.update(task.id, task)
    return c.json({ task: saved ?? task, message: r.message })
  })
}
