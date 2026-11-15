import { withAttachments } from '../../../shared/task.ts'
import type { Agent, Task } from '../../../shared/schema.ts'
import { log } from '../../log.ts'
import { t } from '../../../shared/i18n.ts'
import type { TasksScope } from '../scope.ts'

/** 父对话分派的子对话：立刻开始执行，不再按并发上限排队 */
export async function startChild(sc: TasksScope, sub: Task, message: string, agents: Agent[]) {
  try {
    // 启动中：父对话判断「有没有子对话在跑」时也算上；取到执行位就清掉
    sc.startQueue.add(sub.id)
    let got
    try {
      got = sc.reserve(sub)
    } finally {
      sc.startQueue.delete(sub.id)
    }
    // 同一个子对话已经被启动了：复用正在跑的那一轮，不再开第二个进程
    if (!got.fresh) return
    const entry = got.value
    await sc.start(entry, withAttachments(message, []), true, agents)
    await entry.done
  } catch (e) {
    log.error('task', '子对话执行出错', { task: sub.id, error: (e as Error).message })
    sc.alertOn(sub.id, 'panel', t('执行这个子对话时出错'), 'error')(e)
  }
}
