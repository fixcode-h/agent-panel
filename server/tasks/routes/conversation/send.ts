import { Hono } from 'hono'
import { tasksContract } from '../../../../shared/api-contract/tasks.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Task, type TaskMessage } from '../../../../shared/schema.ts'
import { taskLog } from '../../log.ts'
import { log } from '../../../log.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { returnUserAction } from '../../user-actions.ts'
import { RULE_CMD, TaskBusyError } from '../../helpers.ts'
import { BUG_CMD } from '../../../../shared/builtin/bug-method.ts'
import { bugInPlace, inPlaceBugClosed } from '../../../../shared/bug/in-place.ts'
import { currentTask } from '../../read.ts'

/**
 * POST /tasks/:id/messages：给对话发消息。执行中先试实时送到 CLI（等下一句、插话、read_user_notes），
 * 收不下就记进对话排到这一轮之后；空闲时开新的一轮。/rule、/bug 这类面板命令也在这里处理
 */
export function sendRoute(s: TasksScope): Hono {
  const app = new Hono()
  app.post('/:id/messages', async (c) => {
    const id = c.req.param('id')
    // 入参按前后端共用的契约校验（shared/api-contract/tasks.ts）
    const p = tasksContract.send.body.safeParse(await c.req.json())
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    const { text, attachments, interrupt, messageId, from, userAction, via } = p.data
    const cur = await currentTask(s, id)
    // 别的对话替它发的：按「同项目的其他对话」记来源；发件对话找不到（被删了）就当用户消息，不丢这条
    const sender = from && from !== id ? await currentTask(s, from) : undefined
    const peer = sender ? await s.peerOf(sender, 'peer', 'task', text) : undefined
    const liveNow = s.live.get(id)
    taskLog(id, '收到消息', {
      messageId,
      interrupt: interrupt || undefined,
      attachments: attachments.length || undefined,
      text: text.trim().slice(0, 80),
      from: from || undefined,
      live: !!liveNow,
      status: liveNow?.task.status ?? cur?.status,
      working: liveNow?.task.working,
      awaitingUser: liveNow?.task.awaitingUser,
      prewarming: liveNow?.task.prewarming || undefined,
    })
    // 页面上发的消息最后有没有记进对话：没记进去时页面会撤掉本地那条，日志里要能看出是在哪一步丢的
    const replied = (how: string, task: Task) => {
      const recorded = !messageId || task.messages.some((m) => m.id === messageId)
      taskLog(id, recorded ? '消息已记下' : '消息没有记进对话', { messageId, how, status: task.status })
      return task
    }
    // 进了回收站的对话和 GET /tasks/:id 一样当不存在：不能再往它里面发消息（否则会被重新拉起来跑一轮）
    if (cur?.deletedAt) return s.bad(c, t('任务不存在'), 404)
    if (cur?.imported) return s.bad(c, s.READONLY, 409)
    // 「/rule」：父对话发布全局规则，面板自己处理，不发给 CLI
    if (RULE_CMD.test(text.trim())) {
      const r = await s.ruleCommand(id, text.trim())
      taskLog(id, '面板命令', { cmd: '/rule', error: 'error' in r ? r.error : undefined })
      return 'error' in r ? s.bad(c, r.error) : c.json(r.task)
    }
    // 用户在子对话里发 /bug：标成用户报的 Bug（ADR 0046），它才有 submit_diagnosis、按完整流程查。
    // 正在回复的这一轮里没法换工具，先拦住；挂着等下一句的旧进程由交付时的「选择对不上」重开（runner 的 stillCurrent）
    // 有项目的普通对话也一样就地标（分析稿 B10，shared/bug/in-place.ts）；父对话的 /bug 是派子对话，不标
    const bugCmd = BUG_CMD.test(text.trim()) && !!cur && !peer
    // 修好了才算结束；不修了的可以在这个对话里接着查（用户 2026-11-15 定，shared/bug/reopen.ts）
    const cancelled = cur?.bug?.diagnoses?.at(-1)?.status === 'cancelled'
    if (bugCmd && cur && !cur.parentTaskId && cur.bug?.kind === 'report' && inPlaceBugClosed(cur) && !cancelled)
      return s.bad(c, t('这个对话里的 Bug 已经结束，新的 Bug 请新开一个对话发 /bug'), 409)
    if (bugCmd && cur && !(cur.bug?.kind === 'report') && bugInPlace(cur, await s.deps.agents.list())) {
      const live = s.live.get(id)
      if (live?.task.working)
        return s.bad(
          c,
          cur.parentTaskId
            ? t('子对话正在回复，等这一轮结束或先停止，再发 /bug')
            : t('对话正在回复，等这一轮结束或先停止，再发 /bug'),
          409,
        )
      // 在跑的以内存里那份为准（s.current 拿到的就是它），落盘也落它，不拿旧的盖新的
      cur.bug = { ...cur.bug, kind: 'report' }
      if (live && live.task !== cur) live.task.bug = { ...live.task.bug, kind: 'report' }
      await s.store.update(id, live?.task ?? cur)
      taskLog(id, '面板命令', { cmd: '/bug', mark: 'bug' })
    }
    // 用户直接进子对话回复，就当作回答了它挂在父对话里的提问（不打断这次发送）；别的对话发来的不算用户的回答
    if (!peer)
      await s
        .settleAskFromChild(id, text)
        .catch((e) =>
          log.warn('task', '回答子对话时没能收起父对话的提问卡片', { task: id, error: (e as Error).message }),
        )
    // 用户直接给子对话发消息：父对话计划里挂上等它，做完的状态才会报到父对话并叫起它（不打断这次发送）
    if (cur?.parentTaskId && !peer)
      await s.trackUserToChild(cur, text, via === cur.parentTaskId).catch((e) => {
        log.warn('task', '用户直接发给子对话的要求没能登记到父对话', { task: id, error: (e as Error).message })
        s.alertOn(id, 'delivery', t('这条消息没能登记到父对话的计划里，做完后父对话可能收不到状态'))(e)
      })
    // 交回「等你操作」：先收口那件事，交给 CLI 的内容前面加一句说明，对话里显示的还是用户的原文
    const handBack = userAction && !peer ? await returnUserAction(s, id, userAction, text, attachments) : ''
    let prev = s.runningConv(id)
    if (prev?.task.status === 'running') {
      // 执行中：先试能实时送到 CLI 的办法（等下一句、插话、read_user_notes），
      // 都收不下就把消息记进对话，这一轮结束后马上开始新一轮接着处理
      if (!interrupt) {
        const wf = await s.expandForWorkflow(prev.task, text)
        const expanded = handBack ? `${handBack}\n\n${wf || text}` : wf
        // 附件先拷进任务的执行目录，交给 CLI 的是那一份
        const placed = await s.placeInTask(prev.task, attachments)
        const msg: TaskMessage = {
          // 页面先在本地插了一条「待认领」的：沿用它的 id，推送到达时按 id 换成这一份，不会出现两条
          id: messageId ?? randomUUID(),
          role: 'user' as const,
          agentId: '',
          step: '',
          text,
          ...(expanded ? { prompt: expanded } : {}),
          tools: [],
          ...(attachments.length ? { attachments } : {}),
          ...(peer && { peer }),
          at: new Date().toISOString(),
        }
        const r = await s.deliver(prev, msg, expanded || text, placed).catch((e: Error) => {
          taskLog(id, '发消息失败', { messageId, error: e })
          throw e
        })
        return c.json(replied(r.how, r.task))
      }
      // 打断：停下当前这一轮再发
      s.stopTask(id, 'supersede')
    }
    // 刚执行完、还在落盘的任务：等它写完再接着跑
    prev = s.live.get(id)
    if (prev) {
      taskLog(id, '等上一轮收尾', { messageId, status: prev.task.status })
      await prev.done
    }
    if (s.live.has(id)) {
      taskLog(id, '拒收：正在执行', { messageId })
      return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    }
    try {
      const prompt = handBack ? { prompt: `${handBack}\n\n${text}` } : {}
      return c.json(
        replied('new-turn', await s.followUp(id, { text, attachments, messageId, ...prompt, ...(peer && { peer }) })),
      )
    } catch (e) {
      taskLog(id, '发消息失败', { messageId, error: e as Error })
      // 检查执行位和真正占到之间另一条请求先占了：按「正在执行」返回，不能冒成 500
      if (e instanceof TaskBusyError) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
      throw e
    }
  })
  return app
}
