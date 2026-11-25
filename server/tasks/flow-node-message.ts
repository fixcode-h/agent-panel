/**
 * 用户在流程图里选中一个节点直接发消息（POST /tasks/:id/messages 带 node）：按节点此刻的状态交给它，
 * 判定和对运行的改动在 shared/flow/node-message.ts（演示后端用同一份）。这里只管和执行位打交道：
 * 插话交给这个节点正在跑的 CLI、答等确认的卡、停下在跑的运行再退回、落盘。
 * 消息记在节点上（step = 节点 id），流程图下面的节点详情里看得到自己发过什么
 */
import { randomUUID } from 'node:crypto'
import type { Attachment, DeliveryHow, Task, TaskMessage } from '../../shared/schema.ts'
import type { FlowRun } from '../../shared/tasks/flow-schema.ts'
import { nodeMessagePlan, noteForNode, rerunFromNode, type NodeMsgKind } from '../../shared/flow/node-message.ts'
import { withAttachments } from '../../shared/task.ts'
import { answerRequest } from '../exec/requests.ts'
import { steerTask } from '../exec/steering.ts'
import { t } from '../../shared/i18n.ts'
import { taskLog } from './log.ts'
import type { TasksScope } from './scope.ts'

/** 运行宿主里现成的几样（flow-runs.ts 的闭包），显式传进来 */
export interface NodeMessageCtx {
  sc: TasksScope
  edit: (id: string, fn: (tk: Task) => void) => Promise<Task | null>
  halt: (id: string, by: FlowRun['pausedBy']) => Promise<void>
  resume: (id: string) => Promise<void>
}

export interface NodeMessageInput {
  node: string
  text: string
  attachments: Attachment[]
  messageId?: string
}

const now = () => new Date().toISOString()

export async function messageNode(
  c: NodeMessageCtx,
  id: string,
  m: NodeMessageInput,
): Promise<{ task: Task; kind: NodeMsgKind } | { error: string }> {
  const { sc } = c
  const live = sc.live.get(id)
  const cur = live?.task ?? (await sc.store.get(id))
  if (!cur) return { error: t('任务不存在') }
  const plan = nodeMessagePlan(cur, m.node)
  if ('error' in plan) return plan
  const { step } = plan
  let kind = plan.kind
  const placed = m.attachments.length ? await sc.placeInTask(cur, m.attachments) : []
  const text = withAttachments(m.text, placed)
  const msg = (how: DeliveryHow): TaskMessage => ({
    id: m.messageId ?? randomUUID(),
    role: 'user',
    agentId: '',
    step: step.id,
    text: m.text,
    tools: [],
    ...(m.attachments.length ? { attachments: m.attachments } : {}),
    delivery: { how, at: now() },
    at: now(),
  })
  taskLog(id, '发给节点', { node: step.title, kind, messageId: m.messageId })

  // 在跑：只插给这个节点；它的 CLI 收不下（没有插话协议）就记成给它之后的说明，不改交给别的节点
  if (kind === 'steer' && live) {
    const how = await steerTask(live.task, text, msg('steer'), step.id)
    if (how) {
      live.rev++
      await sc.store.update(id, live.task)
      return { task: live.task, kind }
    }
    kind = 'note'
  }
  // 停在等确认：按「要求修改」答那张卡（和运行卡片上点「修改」一样）
  if (kind === 'revise') {
    const req = live?.task.requests.find((r) => r.kind === 'confirm')
    if (live && req) {
      live.task.messages.push(msg('steer'))
      if (answerRequest(live.task, req.id, { allow: false, answer: text }, randomUUID)) {
        live.rev++
        await sc.store.update(id, live.task)
        return { task: live.task, kind }
      }
      live.task.messages.pop()
    }
    // 运行停着（暂停、面板重启过）：记下回答，接着跑回到确认时直接用
    const after = await c.edit(id, (x) => {
      x.flowRun!.preAnswer = { allow: false, answer: text }
      x.messages.push(msg('next'))
    })
    void c.resume(id)
    return after ? { task: after, kind } : { error: t('任务不存在') }
  }
  if (kind === 'rerun') {
    // 先停下在跑的（别的分支可能还在跑），再退回、接着跑；停下后以存储里的为准
    await c.halt(id, 'user')
    let n = 0
    const after = await c.edit(id, (x) => {
      const s = x.steps.find((y) => y.id === step.id)
      if (!s) return
      n = rerunFromNode(x, s, text, now())
      if (n) x.messages.push(msg('next'))
    })
    if (!after) return { error: t('任务不存在') }
    if (!n) return { error: t('这次运行里没有这个节点') }
    void c.resume(id)
    return { task: after, kind }
  }
  // 还没开始（或在跑但收不下插话）：记成给它的说明，节点开始时带上
  const after = await c.edit(id, (x) => {
    noteForNode(x, step, text, now())
    x.messages.push(msg('next-node'))
  })
  return after ? { task: after, kind } : { error: t('任务不存在') }
}
