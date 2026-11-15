/**
 * 对话页消息流要画哪些段：服务端那份加上待认领的消息、分段、只画最后一部分、最新一轮和正在输出的一轮，
 * 以及轮次目录点一条时先把那一轮显示出来再滚过去。从 TaskView.tsx 拆出来（复查报告 B2）：页面只拿结果往下传
 */
import { useEffect, useMemo, useState } from 'react'
import type { TaskMessage } from '@shared/schema'
import { deliveryActive, deliveryStatus } from '@shared/task'
import type { TaskPage } from '@/lib/api'
import { latestTurnIndex, liveTurnIndex } from '@/lib/latest-turn'
import { ANCHOR_RETRY_MS, ANCHOR_TRIES, jumpToMessage } from '@/lib/message-anchor'
import { blockMsgIds, toBlocks } from '../task-blocks'
import { BLOCK_LIMIT } from '../task-view-pane'

/**
 * 很长的任务先只画最后一部分（BLOCK_LIMIT 段），往前看时再全部显示；换对话回到默认。
 * 单独一个 hook：加载数据那一层（往前翻页）要在算分段之前就拿到 setLimit
 */
export function useBlockLimit(taskId: string) {
  const [limit, setLimit] = useState(BLOCK_LIMIT)
  useEffect(() => setLimit(BLOCK_LIMIT), [taskId])
  return { limit, setLimit }
}

export interface TaskBlocksCtx {
  task: TaskPage | null
  /** 已发出、服务端还没接收的消息（见 use-task-actions 的 pendingMsgs） */
  pendingMsgs: TaskMessage[]
  /** CLI 真的在处理这一轮 */
  working: boolean
  limit: number
  setLimit: React.Dispatch<React.SetStateAction<number>>
}

export function useTaskBlocks({ task, pendingMsgs, working, limit, setLimit }: TaskBlocksCtx) {
  // 对话里要画的消息：服务端那份加上还没被服务端接收的（待认领）。其余地方读的还是服务端的 task
  const shownTask = useMemo(() => {
    if (!task || !pendingMsgs.length) return task
    const ids = new Set(task.messages.map((m) => m.id))
    const fresh = pendingMsgs.filter((m: TaskMessage) => !ids.has(m.id))
    return fresh.length ? { ...task, messages: [...task.messages, ...fresh] } : task
  }, [task, pendingMsgs])
  // 分段只在任务内容变了时重算：打字、开关面板不再把上千条消息重新归一遍
  const blocks = useMemo(() => (shownTask ? toBlocks(shownTask) : []), [shownTask])
  // 很长的任务先只画最后一部分，打开、刷新更快；往前看时再全部显示
  const hidden = Math.max(0, blocks.length - limit)
  // 运行区（子对话、后台命令）只挂在最新的一轮回复下面。不能直接认「最后一段」：
  // 刚发出的用户消息自己就是最后一段，那样运行区会在 AI 说出第一句话之前整块消失
  const latestTurn = useMemo(() => latestTurnIndex(blocks), [blocks])
  // 正在输出的一轮：用户在这一轮进行中插话时，插进去的消息排在后面，但这一轮还在接着想、接着写，
  // 思考和过程不能因此提前折叠（用户 2026-11-13 反馈）。是不是还属于这一轮按交付状态算，不看文字
  const liveTurn = useMemo(
    () =>
      liveTurnIndex(blocks, working, (b) => {
        if (b.kind !== 'msg' || b.m.role !== 'user' || !b.m.delivery || !shownTask) return false
        const s = deliveryStatus(b.m.delivery.how, deliveryActive(b.m.delivery.at, shownTask))
        return !!s && s.tone !== 'warn'
      }),
    [blocks, working, shownTask],
  )
  const shownBlocks = useMemo(() => blocks.slice(hidden), [blocks, hidden])
  // 轮次目录点一条：那一轮在更早没画出来的段里时先显示出来，画好后再按消息标记滚过去（见 message-anchor）
  const jumpToTurn = (msgId: string) => {
    const index = blocks.findIndex((b) => blockMsgIds(b).includes(msgId))
    if (index >= 0) setLimit((l) => Math.max(l, blocks.length - index))
    let tries = 0
    const attempt = () => {
      if (jumpToMessage(msgId) || ++tries >= ANCHOR_TRIES) return
      setTimeout(attempt, ANCHOR_RETRY_MS)
    }
    requestAnimationFrame(attempt)
  }
  return { blocks, hidden, latestTurn, liveTurn, shownBlocks, jumpToTurn }
}
