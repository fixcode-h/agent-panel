/**
 * 父对话执行中，输入框上的「发给…」（分析稿 B1 第 3 条）：用户可以直接点名把这句话发给某个子对话，
 * 面板直接投递、在父对话里留一行记录，不再靠父对话的模型去转（弱模型常说一句「我转给它」却没调用）。
 * 选了谁只是这个页面里的临时选择，不存服务端；发出一条就回到「父对话」，免得后面的话也误发过去
 */
import { useSyncExternalStore } from 'react'
import { Send } from 'lucide-react'
import { t } from '@shared/i18n'
import { ChipSelect, type ChipOpt } from '@/components/ui/chip-select'
import type { ChildSummary } from '../child-line'

// 对话 id → 选中的子对话 id：只是这个页面的临时选择
const picked = new Map<string, string>()
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

/** 能直接发过去的子对话：没收尾的（收尾了的子对话页面上也不给输入框） */
export const sendableKids = (kids: ChildSummary[]) => kids.filter((k) => !k.resolved)

/** 发送时要直接发给的子对话：父对话在执行、选了、那个子对话还在列表里时才有 */
export function sendTargetFor(taskId: string, working: boolean, kids: ChildSummary[]) {
  const id = picked.get(taskId)
  if (!working || !id) return undefined
  return sendableKids(kids).find((k) => k.id === id)
}

/** 发出一条后回到「父对话」 */
export function clearSendTarget(taskId: string) {
  if (picked.delete(taskId)) bump()
}

/** 输入框左下角的「发给…」：只在父对话执行中、名下有能发的子对话时出现 */
export function SendTargetPicker({ taskId, kids }: { taskId: string; kids: ChildSummary[] }) {
  useSyncExternalStore(subscribe, () => version)
  const list = sendableKids(kids)
  if (!list.length) return null
  const cur = picked.get(taskId) ?? ''
  const value = list.some((k) => k.id === cur) ? cur : ''
  const group = t('直接发给子对话')
  const options: ChipOpt[] = [
    { value: '', label: t('发给父对话') },
    ...list.map((k) => ({ value: k.id, label: k.title || k.id, group })),
  ]
  return (
    <ChipSelect
      value={value}
      options={options}
      onChange={(v) => {
        if (v) picked.set(taskId, v)
        else picked.delete(taskId)
        bump()
      }}
      title={t('执行中点名发给某个子对话：消息直接交给它，父对话里留一行记录')}
      // 选了子对话时按钮用强调色：一眼看出这条不是发给父对话的
      className={value ? 'text-accent-text' : undefined}
      plain
      icon={() => <Send aria-hidden className="h-3.5 w-3.5 shrink-0" />}
    />
  )
}
