// 父对话分诊和交代子对话的记录（从 shared/engine.ts 搬来，Orchestra 的对话类工具和引擎共用）
import type { TaskRoute } from '../schema.ts'
import { type HandOffs } from '../peer-message.ts'
import type { EngineHost, RouteInput } from '../engine/host.ts'

const now = () => new Date().toISOString()

/**
 * 每个父对话交给子对话的话 → 交给了哪个子对话、当时是哪条用户消息（见 sendToConversation：
 * 用户的一条消息只交给一个子对话）。范围和 sentToOther 一致（见 shared/peer-message.ts 的 handedToOther）
 */
export const handedOff = new WeakMap<object, HandOffs>() // 模块状态：运行时，消息交给了哪个子对话，重启后可能再交一次

/** send_to_conversation 送到之后跟在返回后面的一句：这一轮可以结束、怎么跟用户说、不要猜状态 */
export const SENT_NOTE =
  '交出去了：这一轮可以结束，它做完会自动推回结果。给用户只说「已交回，等它的结果」，不要轮询，也不要拿 busy、「已完成」这类状态去猜它接没接到；用户问起时用 list_conversations 看一次 lastActivityAt 是否比交回的时间新。'

/**
 * 记一条分诊：只记父对话（能分派子对话的顶层对话）的，界面画成分诊卡。
 * 出自哪条消息按最后一条用户消息算（这一轮就是在回应它）
 */
export function recordRoute(
  host: EngineHost,
  target: TaskRoute['target'],
  refs: string[],
  label: string,
  route: RouteInput | undefined,
) {
  const { task } = host
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : '')
  const ask = [...task.messages].reverse().find((m) => m.role === 'user' && !m.peer)
  task.routes = [
    ...(task.routes ?? []).slice(-499),
    {
      id: host.newId(),
      target,
      refs: refs.slice(0, 20),
      label: label.slice(0, 200),
      understanding: str(route?.understanding),
      reason: str(route?.reason),
      assumptions: str(route?.assumptions),
      messageId: ask?.id ?? '',
      at: now(),
    },
  ]
}
