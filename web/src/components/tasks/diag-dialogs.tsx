import { useState } from 'react'
import { CollabLog } from './CollabLog'
import { LifecycleDialog } from './LifecycleDialog'

/**
 * 对话菜单里两个排查用的弹窗：「状态」（CLI 生命周期诊断，见 LifecycleDialog）和「父子往来记录」（见 CollabLog）。
 * 开关和弹窗放在这里，菜单项（可钉在标题栏）在任务页的标题栏清单里调 openStatus / openCollab；「等待模型」那一行点了也调 openStatus。
 * 菜单收起时菜单内容会卸载，所以开关的状态要在任务页这一层（hook），不能放在菜单项里。
 * hook 要在任务页的提前返回之前调用，那时还拿不到任务：弹窗做成渲染时再给参数的函数
 */
export function useDiagDialogs(taskId: string) {
  const [collab, setCollab] = useState(false)
  const [status, setStatus] = useState(false)
  const dialogs = (onOpenChild?: (id: string) => void) => (
    <>
      {collab && <CollabLog taskId={taskId} onClose={() => setCollab(false)} onOpenChild={onOpenChild} />}
      {status && <LifecycleDialog taskId={taskId} onClose={() => setStatus(false)} />}
    </>
  )
  return { dialogs, openStatus: () => setStatus(true), openCollab: () => setCollab(true) }
}
