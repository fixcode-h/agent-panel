import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import { restartInterrupted, taskDeleted } from '../../shared/task.ts'
import { settleStopped } from '../../shared/task-settle.ts'
import type { createTaskStore } from '../task-store.ts'

type Store = Pick<ReturnType<typeof createTaskStore>, 'list' | 'get' | 'update'>

/**
 * 服务重启时的迁移：之前没跑完的任务标记为已停止；正在跑的节点记为被打断，继续执行时续接它的会话。
 * tasksApi 把它的结果暴露成 ready：读取「被更新打断的任务」时要等这一步做完，否则还会读到 running。
 */
export async function migrateOnStart(store: Store) {
  const all = await store.list()
  // 除了重启前在跑的，还有「这一轮说完了但计划没做完 / 独立分支还没合回」的任务：进程已经回收，
  // 界面却还会画成转圈（childIcon 对 unfinished 也返回 running），一直算进「N 个执行中」。
  // 两种都落成已停止，重启后没人接着做的事不再显示成在执行（见 restartInterrupted）
  // 进了回收站的对话不在这里处理：用户已经把它删了，恢复后不该带着一条「已中断，点继续执行」
  for (const meta of all.filter((x) => (x.status === 'running' || restartInterrupted(x)) && !taskDeleted(x))) {
    // 列表里只有用户消息，改之前取完整的
    const task = await store.get(meta.id)
    if (!task) continue
    // 面板重启、服务退出打断的，不是用户按的暂停：界面要说清原因。结算口径见 settleStopped
    const next = settleStopped(task, 'restart')
    next.messages = [
      ...task.messages,
      {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text:
          task.status === 'running'
            ? t(
                '面板关闭或重启时任务还在执行，已中断。点「继续执行」从中断的节点接着做（会续接那个节点的 Agent 会话）。',
              )
            : t('面板重启时这件事还没收尾，已经不在执行。接着做就发消息，会重新拉起 CLI 接着做。'),
        tools: [],
        transient: true,
        at: new Date().toISOString(),
      },
    ]
    await store.update(task.id, next)
  }
  // 合并到一半面板退出的子对话：「合并中」只在内存里有效，重启后没人在合，finish_child 和 submit_merge 却都按它拒绝，
  // 父子两边都卡住。退回「已请求收尾」，并告诉父对话重新 finish_child
  for (const meta of all.filter((x) => x.wrapRequest?.state === 'merging' && !taskDeleted(x)))
    await reopenMerge(store, meta.id, '合回父对话分支时面板重启了')
}

/**
 * 「合并中」没人在合：退回「已请求收尾」，并在父对话的收件箱里留一句让它重新 finish_child。
 * why 写进那句话的开头（面板重启了 / 面板核对时发现没在合），返回改没改
 */
export async function reopenMerge(store: Store, id: string, why: string): Promise<boolean> {
  const kid = await store.get(id)
  if (!kid?.wrapRequest || kid.wrapRequest.state !== 'merging') return false
  await store.update(kid.id, { ...kid, wrapRequest: { ...kid.wrapRequest, state: 'requested' } })
  const parent = kid.parentTaskId ? await store.get(kid.parentTaskId) : null
  if (!parent) return true
  const text = `【子对话状态】「${kid.title}」（id ${kid.id}）${why}，这次合并没有完成，收尾请求退回待处理：重新调用 finish_child 合回它。`
  await store.update(parent.id, {
    ...parent,
    inbox: [...parent.inbox, { from: kid.id, title: kid.title, text, at: new Date().toISOString() }],
  })
  return true
}
