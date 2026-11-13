/**
 * Bug 诊断报告的确认（ADR 0045）：用户在审阅弹窗里确认方案或标出疑问。
 * 只记决定、收起等确认的请求，返回交给子对话的话；页面再把这段话作为用户消息发给子对话（走普通的发消息，
 * 在跑、在等下一句、停着都由那条路处理），这里不另写一套投递
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
import { decideDiagnosis, settleCleanup } from '../../shared/bug/diagnosis.ts'
import { DiagnosisNote } from '../../shared/bug/diagnosis-schema.ts'
import { cleanupPrompt } from '../../shared/bug/cleanup.ts'
import { phaseOf, revOf } from '../../shared/bug/phase.ts'
import type { TasksScope } from './scope.ts'
import { previewCleanup, snapshotLogBase, snapshotPre } from './bug-cleanup.ts'

const Decision = z.object({
  approve: z.boolean(),
  /** 用户点了「取消」：这次不修。代码里有临时日志时先叫它删（返回要交给子对话的话），否则计划收口、对话等下一句 */
  cancel: z.boolean().default(false),
  /** 取消时用户勾了要一起删的、为排查新建的文件（只认面板查出来的那几个） */
  drop: z.array(z.string().max(500)).max(50).default([]),
  /** 取消时用户要求修复也撤掉（共用目录、已修完时） */
  revertFix: z.boolean().default(false),
  /** 用户贴了日志（论证复现的结果、验证的结果）：logs 是文字，logFiles 是日志文件的路径（也随消息交给子对话） */
  supply: z.boolean().default(false),
  logs: z.string().max(200000).default(''),
  logFiles: z.array(z.string().max(500)).max(20).default([]),
  /** 退回的意图（用户 2026-11-13 定）：ask 提问、补充，要它据此重出一版；reject 不认同、推翻重查 */
  intent: z.enum(['ask', 'reject']).optional(),
  notes: z
    .array(DiagnosisNote.omit({ id: true }))
    .max(50)
    .default([]),
  overall: z.string().max(4000).default(''),
  /** 同意时勾了「后面几步没有要注意的就自动通过」（分析稿 B2） */
  autoNext: z.boolean().default(false),
})

/** 临时日志没删干净时用户的选择：retry 让它再删一次；finish 我自己删 / 保留，直接关闭报告 */
const CleanupAction = z.object({ action: z.enum(['retry', 'finish']) })

export function registerDiagnosisRoutes(s: TasksScope) {
  const taskOf = async (id: string) => {
    const entry = s.live.get(id)
    // 诊断报告不挂在 CLI 进程上：子对话停着、不在内存里也能确认，改完落盘
    return { entry, task: entry?.task ?? (await s.store.get(id)) }
  }

  /** 点「取消修复」之前：面板只读地查出代码里的临时日志、这个对话新建的文件，确认框里列出来 */
  s.routes.get('/:id/diagnosis-cleanup', async (c) => {
    const { task } = await taskOf(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    return c.json(await previewCleanup(task, await s.taskDir(task).catch(() => '')))
  })

  s.routes.post('/:id/diagnosis/:version', async (c) => {
    const body = Decision.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const { entry, task } = await taskOf(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    // 取消要收口计划：它在回复（等确认期间用户又发了话）时会和这一轮抢着写，等它停下再取消
    if (body.data.cancel && task.working) return s.bad(c, t('它正在回复，等这一轮结束再取消'), 409)
    const version = Number(c.req.param('version'))
    const dir = await s.taskDir(task).catch(() => '')
    // 取消：服务端自己查临时日志（不信页面传的），有就先叫它删；用户勾的新文件只认查出来的那几个
    let cleanup
    if (body.data.cancel) {
      const p = await previewCleanup(task, dir)
      const drop = body.data.drop.filter((f) => p.created.includes(f))
      const files = [...new Set(p.found.map((x) => x.file))]
      cleanup = { found: p.found, drop, revertFix: body.data.revertFix, pre: await snapshotPre(task, dir, files) }
    }
    const r = decideDiagnosis(task, version, body.data, randomUUID, undefined, cleanup)
    if (!r.ok) return s.bad(c, r.error, 409)
    // 同意加日志：给日志计划里的文件拍快照，取消修复后核对「日志和空行删干净了」用（不拿来还原）
    const d = task.bug?.diagnoses?.find((x) => x.version === version)
    if (d && body.data.approve && phaseOf(d) === 'evidence') await snapshotLogBase(task, dir, d).catch(() => {})
    if (body.data.cancel) task.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    const saved = await s.store.update(task.id, task)
    return c.json({ task: saved ?? task, message: r.message })
  })

  /** 临时日志没删干净（核对没过）时用户的选择 */
  s.routes.post('/:id/diagnosis-cleanup', async (c) => {
    const body = CleanupAction.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const { entry, task } = await taskOf(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    const d = task.bug?.diagnoses?.at(-1)
    const cl = d?.cleanup
    if (!d || !cl || cl.state !== 'failed') return s.bad(c, t('现在没有要处理的临时日志'), 409)
    if (task.working) return s.bad(c, t('它正在回复，等这一轮结束再处理'), 409)
    let message = ''
    if (body.data.action === 'retry') {
      cl.state = 'running'
      message = cleanupPrompt({
        rev: revOf(d),
        found: cl.found,
        drop: cl.drop,
        revertFix: cl.revertFix,
        failed: cl.failed,
      })
    } else settleCleanup(task, { state: 'skipped', failed: cl.failed, kept: cl.kept }, randomUUID)
    task.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    const saved = await s.store.update(task.id, task)
    if (body.data.action === 'finish' && task.parentTaskId) await s.reportToParent(saved ?? task).catch(() => {})
    return c.json({ task: saved ?? task, message })
  })
}
