import type { Task } from '../../../shared/schema.ts'
import { helperRunning } from '../../../shared/tasks/helpers.ts'
import { cancelWait } from '../../exec/steering.ts'
import { stopHelper } from '../../../shared/run/stops.ts'
import { t } from '../../../shared/i18n.ts'
import { HELPER_STOP_TIMEOUT_MS, HELPER_STOP_POLL_MS } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'

/** 停下子对话这一侧：停它派出去的子任务（用户点「解决」前），父对话收尾时一起停名下的子对话 */

/**
 * 停掉这个对话派出去、还在跑的子任务，等它们真的结束（有上限）。
 * 和界面的「终止子任务」走同一条路（stopHelper），不碰对话本身和别的子任务。
 */
export async function stopChildHelpers(
  sc: TasksScope,
  childId: string,
  tk: Task,
): Promise<{ ok: boolean; info: string }> {
  // 子任务结束时引擎改的是 live 里那份任务：轮询按它判断，不要拿开头的快照一直看到 running
  const running = () => (sc.live.get(childId)?.task ?? tk).steps.filter(helperRunning)
  if (!running().length) return { ok: true, info: '' }
  for (const s of running()) stopHelper(childId, s.id, t('用户点了「解决」：先停掉还在跑的子任务再收口'))
  const until = Date.now() + HELPER_STOP_TIMEOUT_MS
  while (running().length) {
    if (Date.now() >= until)
      return {
        ok: false,
        info: t('这些子任务还没停下来：{list}。等它们结束再点「解决」', {
          list: running()
            .map((s) => `「${s.title}」`)
            .join('、'),
        }),
      }
    await new Promise((r) => setTimeout(r, HELPER_STOP_POLL_MS))
  }
  return { ok: true, info: '' }
}

export async function closeChildren(sc: TasksScope, parentId: string) {
  const kids = (await sc.store.list()).filter((x) => x.parentTaskId === parentId && sc.live.has(x.id))
  // 先一起发停止、再一起等：一个一个等的话每个子对话收尾最多要几秒（杀进程树、写盘），
  // 父对话名下十几个子对话时停一次父对话就要卡上一两分钟，期间新的请求也排在后面
  await Promise.all(
    kids.map(async (k) => {
      const entry = sc.live.get(k.id)
      if (!entry) return
      // 正在等下一句的直接结束这一轮；正在执行的按停止处理（输出和状态都保留）。
      // 原因是 parent：父对话收尾停的子对话不能显示成「用户按了暂停」
      if (!cancelWait(k.id)) sc.stopTask(k.id, 'parent')
      if (entry.done) await entry.done.catch(() => {})
      if (sc.live.has(k.id)) sc.stopTask(k.id, 'parent')
    }),
  )
}
