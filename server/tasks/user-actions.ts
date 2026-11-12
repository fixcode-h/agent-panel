/**
 * 等你操作（request_user_action）的服务端：用户点「完成了」「做不了」「跳过」、在输入框交回、停止对话时撤掉。
 * 判定和记录在 shared/user-action.ts；设计见 docs/openspec/changes/user-action-wait/design.md
 */
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
import { settleWait } from '../../shared/plan.ts'
import type { Task } from '../../shared/schema.ts'
import { subtreeTaskIds } from '../../shared/run/usage.ts'
import {
  CANCEL_STOPPED,
  cancelAction,
  pendingAction,
  settleAction,
  type ActionSettle,
} from '../../shared/user-action.ts'
import { taskLog } from './log.ts'
import type { TasksScope } from './scope.ts'

const Settle = z.object({
  how: z.enum(['done', 'cannot', 'skipped']),
  /** 做不了的原因（必填，Agent 才知道换什么办法） */
  reason: z.string().max(4000).default(''),
})

/**
 * 记下用户怎么结束等待，计划里等它的那一步跟着收口；返回推给 Agent 的那一句（不翻译）。
 * 做不了算等的结果没成功：那一步退回进行中、写明缺什么，由 Agent 换办法
 */
export function settleUserAction(
  tk: Task,
  actionId: string,
  how: ActionSettle,
  reply: { text?: string; files?: string[] } = {},
) {
  const r = settleAction(tk, actionId, how, reply)
  if (!r.ok) return r
  settleWait(tk, 'user', actionId, how !== 'cannot')
  tk.updatedAt = new Date().toISOString()
  taskLog(tk.id, '等你操作结束', { action: actionId, how })
  return r
}

export function registerUserActionRoutes(s: TasksScope) {
  // 「完成了」「做不了」「跳过」：记下结果、把那一句推给对话开新的一轮（交回内容走普通的发消息，见 conversation-routes）
  s.routes.post('/:id/user-action/:aid', async (c) => {
    const id = c.req.param('id')
    const body = Settle.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const entry = s.live.get(id)
    // 等你操作时这一轮已经结束：多半不在内存里，从盘上取
    const task = entry?.task ?? (await s.store.get(id))
    if (!task || task.deletedAt) return s.bad(c, t('任务不存在'), 404)
    const r = settleUserAction(task, c.req.param('aid'), body.data.how, { text: body.data.reason })
    if (!r.ok) return s.bad(c, r.error, 409)
    if (entry) entry.rev++
    await s.store.update(task.id, task)
    // 交付可能要等这一轮收尾（排到下一轮），不让按钮一直转：后台交，交不出去在对话里留警告
    void s
      .wakeConv(id, r.prompt, { panel: 'action' })
      .catch(s.alertOn(id, 'delivery', t('没能把你的操作结果交给它，发一条消息或点「继续执行」会接着处理')))
    return c.json(await s.current(id))
  })
}

/**
 * 用户停止对话：这棵树里还在等用户做的事一起撤掉。停止就是「这件事先别干了」，
 * 留着它对话会一直算「等你处理」，停止按钮按了也没变化
 */
export async function cancelUserActions(s: TasksScope, id: string) {
  const all = await s.store.list()
  for (const tid of subtreeTaskIds(all, id)) {
    const first = s.live.get(tid)?.task ?? all.find((x) => x.id === tid)
    if (!first || !pendingAction(first)) continue
    const e = s.live.get(tid)
    const tk = e?.task ?? (await s.store.get(tid))
    const a = tk && cancelAction(tk, CANCEL_STOPPED())
    if (!tk || !a) continue
    settleWait(tk, 'user', a.id, false)
    tk.updatedAt = new Date().toISOString()
    if (e) e.rev++
    taskLog(tid, '停止：撤掉等你操作', { action: a.id })
    await s.store.update(tid, tk)
  }
}

/**
 * 用户在输入框里交回（挂着「交回给」发送）：收口那件事、落盘，返回交给 CLI 时加在用户原文前面的一句。
 * 那件事已经结束（另一个窗口刚点了跳过）就当普通消息发，不拦这次发送
 */
export async function returnUserAction(
  s: TasksScope,
  id: string,
  actionId: string,
  text: string,
  files: { path: string }[],
): Promise<string> {
  const e = s.live.get(id)
  const tk = e?.task ?? (await s.store.get(id))
  if (!tk) return ''
  const r = settleUserAction(tk, actionId, 'returned', { text, files: files.map((f) => f.path) })
  if (!r.ok) return ''
  if (e) e.rev++
  await s.store.update(tk.id, tk)
  return r.prompt
}
