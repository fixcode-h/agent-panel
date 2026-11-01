import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import type { Task, TaskMessage } from '../../shared/schema.ts'
import { failLostWaits } from '../../shared/plan-lost.ts'
import { restartInterrupted, taskDeleted } from '../../shared/task.ts'
import { droppedAsksNote, settleStopped } from '../../shared/task-settle.ts'
import type { createTaskStore } from '../task-store.ts'
import { rebuildClaims, type createClaims } from '../claims.ts'

type Store = Pick<ReturnType<typeof createTaskStore>, 'list' | 'get' | 'update'>

/**
 * 服务重启时的迁移：之前没跑完的任务标记为已停止；正在跑的节点记为被打断，继续执行时续接它的会话。
 * tasksApi 把它的结果暴露成 ready：读取「被更新打断的任务」时要等这一步做完，否则还会读到 running。
 */
export async function migrateOnStart(store: Store, claims?: ReturnType<typeof createClaims>) {
  const all = await store.list()
  // 刚启动时内存里一条排队的消息都没有：落盘里还写着「这一轮结束后处理」的已经没人处理了（界面又按 working
  // 把它画成正常送达）。和这一轮被停下时（run.ts 的 dropHeld）一样改成「没送出去」，用户才知道要重发。
  // notes 不动：它可能已经被 read_user_notes 取走（取走时不改 delivery），分不出来
  const lostHeld = (m: TaskMessage) => m.role === 'user' && m.delivery?.how === 'held'
  const stamp = new Date().toISOString()
  const markLost = (list: TaskMessage[]) =>
    list.map((m) => (lostHeld(m) ? { ...m, delivery: { how: 'lost' as const, at: stamp } } : m))
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
      ...markLost(task.messages),
      {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: [
          task.status === 'running'
            ? t(
                '面板关闭或重启时任务还在执行，已中断。点「继续执行」从中断的节点接着做（会续接那个节点的 Agent 会话）。',
              )
            : t('面板重启时这件事还没收尾，已经不在执行。接着做就发消息，会重新拉起 CLI 接着做。'),
          // 提问 / 确认被 settleStopped 清掉了（回调跟着进程没了）：卡片没了要说为什么
          droppedAsksNote(task),
        ]
          .filter(Boolean)
          .join('\n'),
        tools: [],
        transient: true,
        at: new Date().toISOString(),
      },
    ]
    await store.update(task.id, next)
  }
  // 上面没处理的（status 不是 running、也不在恢复名单里）还可能带着 working / awaitingUser / prewarming：
  // 崩溃时这一轮的收尾没来得及落盘。刚启动时一个 CLI 进程都没有，这些「在用」标记都是假的，
  // 不清掉的话清理（cleanup.ts 的 chatBusy、sweepTaskInfoOf）永远当它在用，保活上限也会把它算进去
  for (const meta of await store.list())
    if (meta.working === true || meta.awaitingUser === true || meta.prewarming === true) {
      const task = await store.get(meta.id)
      if (!task) continue
      await store.update(
        task.id,
        { ...task, working: false, awaitingUser: false, prewarming: false },
        { keepUpdatedAt: true },
      )
    }
  // 还写着「这一轮结束后处理」的消息（上面没碰的旧数据）和计划里等后台命令的步骤：后台命令的记录只在内存里，
  // 刚启动时一条都不认识（createJobs 在这之后才建），结果不会再来。计划在列表元数据里，先在副本上试一次，
  // 有要收的才读完整记录；不等用户打开（子对话被父对话的 resumeKids 拉起时不经过 withLive 的 reapLostJobs）
  const lostWaits = (x: Pick<Task, 'plans' | 'steps'>) => failLostWaits(x, 'background', () => false)
  for (const meta of await store.list()) {
    if (taskDeleted(meta)) continue
    if (!meta.messages.some(lostHeld) && !lostWaits({ plans: structuredClone(meta.plans), steps: meta.steps })) continue
    const task = await store.get(meta.id)
    if (!task) continue
    lostWaits(task)
    await store.update(task.id, { ...task, messages: markLost(task.messages) }, { keepUpdatedAt: true })
  }
  // 合并到一半面板退出的子对话：「合并中」只在内存里有效，重启后没人在合，finish_child 和 submit_merge 却都按它拒绝，
  // 父子两边都卡住。退回「已请求收尾」，并告诉父对话重新 finish_child
  for (const meta of all.filter((x) => x.wrapRequest?.state === 'merging' && !taskDeleted(x)))
    await reopenMerge(store, meta.id, '合回父对话分支时面板重启了')
  // 认领只在内存里：还没交出去的共用目录子对话按记录里改过的文件补回（列表里带 changes，不用读全量）
  if (claims) rebuildClaims(claims, await store.list())
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
