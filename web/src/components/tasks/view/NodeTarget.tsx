/**
 * 工作流运行的流程图里选中了节点时，输入框左下角的「发给…」：可以把这句话直接发给选中的节点，
 * 不再只能发给整个运行（以前执行中的补充交给所有在跑的节点，做完的节点没法再提意见）。
 * 节点此刻收到会怎么处理（插话 / 修改 / 开始时带上 / 退回重跑）由 shared/flow/node-message.ts 判定，输入框提示照它写。
 * 默认：在跑、等确认、还没开始的节点直接发给它；做完的节点发过去会退回重跑，代价大，默认还是发给整个运行，要用户自己选。
 * 选择只是这个页面的临时状态（和 SendTarget 一样），按「对话 + 节点」记，发出一条后回到默认
 */
import { useSyncExternalStore } from 'react'
import { Send } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task, TaskMessage, TaskStep } from '@shared/schema'
import { nodeMessageDone, nodeMessageHint, nodeMessagePlan, type NodeMsgKind } from '@shared/flow/node-message'
import { toast } from '@/lib/toast'
import { ChipSelect, type ChipOpt } from '@/components/ui/chip-select'

// 「对话 id/节点 id」→ 用户选的：true 发给节点，false 发给整个运行；没选过按默认
const picked = new Map<string, boolean>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => {
  version++
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const keyOf = (taskId: string, node: TaskStep) => `${taskId}/${node.id}`

/** 选中的节点能不能直接发、发过去会怎么处理；不能发时为空 */
function planOf(task: Pick<Task, 'steps' | 'flowRun'>, node?: TaskStep) {
  if (!node || !task.flowRun) return undefined
  const p = nodeMessagePlan(task, node.id)
  return 'error' in p ? undefined : p
}

/** 退回重跑代价大：不默认选，其余默认发给节点 */
const defaultOn = (kind: NodeMsgKind) => kind !== 'rerun'

/** 发送时要直接发给的节点：选中了节点、它能收、用户（或默认）选了发给它 */
export function nodeTargetFor(task: Pick<Task, 'id' | 'steps' | 'flowRun'>, node?: TaskStep) {
  const p = planOf(task, node)
  if (!p || !node) return undefined
  return (picked.get(keyOf(task.id, node)) ?? defaultOn(p.kind)) ? p : undefined
}

/** 发出一条后回到默认（尤其是退回重跑：不能让下一句也跟着再退回一次） */
export function clearNodeTarget(taskId: string, node?: TaskStep) {
  if (node && picked.delete(keyOf(taskId, node))) bump()
}

/**
 * 发给节点成功后：回到默认，回执按服务端实际怎么交的说
 * （节点的 CLI 收不下插话时服务端改成留给它之后，消息记成 next-node）
 */
export function afterNodeSend(
  taskId: string,
  node: TaskStep | undefined,
  target: { kind: NodeMsgKind; step: TaskStep },
  sent: Pick<Task, 'messages'>,
  messageId: string,
) {
  clearNodeTarget(taskId, node)
  const how = sent.messages.find((m) => m.id === messageId)?.delivery?.how
  toast.info(nodeMessageDone(how === 'next-node' ? 'note' : target.kind, target.step.title))
}

/** 流程图视图里选中的节点（TaskView 里按视图和选中的步骤 id 取） */
export const flowNodeOf = (task: Pick<Task, 'mode' | 'steps'> | null, flow: boolean, id: string) =>
  task?.mode === 'workflow' && flow ? task.steps.find((s) => s.id === id) : undefined

/** 节点详情里也画刚发给节点、服务端还没记下的那条（待认领） */
export const withPending = <T extends Pick<Task, 'messages'>>(task: T, pending: TaskMessage[]): T =>
  pending.length ? { ...task, messages: [...task.messages, ...pending] } : task

/** 输入框里的提示：发给节点时写清这条会怎么交；没发给节点时为空，用原来的提示 */
export function useNodeTargetHint(task: Pick<Task, 'id' | 'steps' | 'flowRun'>, node?: TaskStep) {
  useSyncExternalStore(subscribe, () => version)
  const p = nodeTargetFor(task, node)
  return p ? nodeMessageHint(p.kind, p.step.title) : ''
}

/** 输入框左下角的「发给…」：只在工作流运行的流程图里选中了能收消息的节点时出现 */
export function NodeTargetPicker({ task, node }: { task: Pick<Task, 'id' | 'steps' | 'flowRun'>; node?: TaskStep }) {
  useSyncExternalStore(subscribe, () => version)
  const p = planOf(task, node)
  if (!p || !node) return null
  const on = !!nodeTargetFor(task, node)
  const options: ChipOpt[] = [
    { value: '', label: t('发给整个运行') },
    {
      value: node.id,
      label:
        p.kind === 'rerun' ? t('退回「{node}」重跑', { node: node.title }) : t('发给「{node}」', { node: node.title }),
      group: t('选中的节点'),
    },
  ]
  return (
    <ChipSelect
      value={on ? node.id : ''}
      options={options}
      onChange={(v) => {
        picked.set(keyOf(task.id, node), !!v)
        bump()
      }}
      title={t('直接发给流程图里选中的节点：在跑的插进它这一轮，没开始的等它开始时带上，做完的带着意见退回重跑')}
      // 发给节点时按钮用强调色：一眼看出这条不是发给整个运行的
      className={on ? 'text-accent-text' : undefined}
      plain
      icon={() => <Send aria-hidden className="h-3.5 w-3.5 shrink-0" />}
    />
  )
}
