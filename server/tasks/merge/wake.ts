import { type PeerFrom, type TaskMessage, type Task } from '../../../shared/schema.ts'
import { type ConvState } from '../../../shared/task.ts'
import { log } from '../../log.ts'
import { t } from '../../../shared/i18n.ts'
import type { TasksScope } from '../scope.ts'
import { readTask } from '../read.ts'

/**
 * 把面板的消息交给一个对话并让它马上处理（按 runningConv 交付，见 wakeConv）；
 * 交不出去（这一轮没正常结束、被别的操作占着）就退回收件箱，它下一轮开始时一起处理
 */
export async function wakeTask(
  sc: TasksScope,
  id: string,
  from: Task,
  text: string,
  meta: {
    panel?: TaskMessage['panel']
    child?: { id: string; title: string; state: ConvState }
    /** 发件对话：收件方画成一行「接收消息」 */
    peer?: PeerFrom
  } = {},
): Promise<boolean> {
  try {
    await sc.wakeConv(id, text, {
      panel: meta.panel ?? 'child',
      ...(meta.child && { child: meta.child }),
      ...(meta.peer && { peer: meta.peer }),
    })
    return true
  } catch (e) {
    log.warn('task', '没能马上交给对话，放进收件箱', { task: id, error: (e as Error).message })
    sc.alertOn(id, 'delivery', t('一条消息没能马上交给这个对话，已放进收件箱'))(e)
    await sc.noteParent(id, from, text, text, undefined, meta.child, meta.peer)
    return false
  }
}

/** 收尾请求进了收件箱之后的复查：父对话还空着、请求还没处理，就推它一次（见 drive.ts 的 nudgeWrapUp） */
export async function recheckWrapUp(sc: TasksScope, parentId: string) {
  const parent = await readTask(sc, parentId)
  if (!parent || sc.live.has(parentId)) return
  await sc
    .nudgeWrapUp(parent)
    .catch((e) => log.warn('task', '复查父对话收尾失败', { task: parentId, error: (e as Error).message }))
}
