/**
 * 派新 Bug 时查观察期里的同类 Bug（分析稿 B13，判定在 shared/bug/observe.ts）：对上了就关联——
 * 原来那个记一笔、对话里留一行，新 Bug 的派单附上原来的根因和修法，给父对话的返回里提示重开。
 * 放在单独的文件里：spawn-child.ts 只加调用
 */
import { randomUUID } from 'node:crypto'
import { findRelapse, markRelapse, observingUntil, relapseInfo, relapseNote } from '../../shared/bug/observe.ts'
import { log } from '../log.ts'
import { taskLog } from '../task-log.ts'
import type { TasksScope } from './scope.ts'

export async function linkRelapse(
  sc: Pick<TasksScope, 'live' | 'store'>,
  fresh: { id: string; title: string; projectId: string; text: string },
): Promise<{ origId: string; note: string; info: string } | undefined> {
  try {
    // 在跑的以内存里那份为准，落盘也落它
    const all = (await sc.store.list()).map((x) => sc.live.get(x.id)?.task ?? x)
    const orig = findRelapse(all, fresh)
    const until = orig && observingUntil(orig)
    if (!orig || !until) return undefined
    markRelapse(orig, fresh, randomUUID())
    const live = sc.live.get(orig.id)
    if (live) live.rev++
    await sc.store.update(orig.id, orig)
    taskLog(orig.id, '观察期里又报了同类 Bug', { fresh: fresh.id })
    return { origId: orig.id, note: relapseNote(orig, until), info: relapseInfo(orig) }
  } catch (e) {
    // 关联不上不挡派单：新 Bug 照常开，只是少了原来的记录，留日志
    log.warn('task', '查观察期里的同类 Bug 失败', { task: fresh.id, error: (e as Error).message })
    return undefined
  }
}
