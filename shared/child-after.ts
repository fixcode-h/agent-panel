import type { Task } from './schema.ts'
import { stopEnds, taskDeleted } from './task.ts'

/**
 * 子对话之间的先后依赖（create_conversation 的 after）：B 排在 A 之后时，面板先建好 B 但不启动，
 * A 合回父对话的分支（或只读的 A 已经完成）后自动启动 B，B 要开独立分支时从合回后的提交开；
 * A 失败、没了时不启动 B，告诉父对话。以前父对话只能等 A 收尾把自己叫醒再派 B，每次接力都是父对话带着全部上下文的一整轮。
 * 这里只放判定，状态的读写和启动在 server/tasks/after-deps.ts
 */

/** 判定要看的前置子对话字段 */
export type AfterPred = Pick<Task, 'id' | 'title' | 'status' | 'stopReason' | 'resolved' | 'mergedAt'> &
  Partial<Pick<Task, 'deletedAt' | 'archived'>>

/** 前置子对话现在的情况：done 已经合回或完成；bad 失败或没了（不会自己回来）；其余还在做 */
export function predState(p: AfterPred | undefined): 'done' | 'bad' | 'pending' {
  if (!p || taskDeleted(p) || p.archived) return 'bad'
  if (p.resolved || p.mergedAt) return 'done'
  if (p.status === 'failed') return 'bad'
  // 归档、删除、换人接手、核对时收口：这些停下的不会再回来。用户暂停、面板重启这类只是暂停，还会接着做
  if (p.status === 'stopped' && stopEnds(p.stopReason)) return 'bad'
  return 'pending'
}

/** 正在等前置的子对话：建好了、还没启动过（停在 after），名单不空 */
export const waitingAfter = (k: Pick<Task, 'status' | 'stopReason' | 'waitAfter'>) =>
  !!k.waitAfter?.length && k.status === 'stopped' && k.stopReason === 'after'

/**
 * 等前置的子对话下一步怎么办：全部 done 就启动；有 bad 的列出来交给父对话（它仍然等着，前置修好合回后照样自动开始）；
 * 其余继续等。前置的 id 找不到记录也算 bad
 */
export function afterDecision(
  ids: string[],
  find: (id: string) => AfterPred | undefined,
): { start: true } | { start: false; bad: { id: string; title: string; why: string }[]; pending: string[] } {
  const bad: { id: string; title: string; why: string }[] = []
  const pending: string[] = []
  for (const id of ids) {
    const p = find(id)
    const s = predState(p)
    if (s === 'done') continue
    if (s === 'pending') pending.push(p?.title ?? id)
    else bad.push({ id, title: p?.title ?? id, why: predWhy(p) })
  }
  return bad.length || pending.length ? { start: false, bad, pending } : { start: true }
}

/** 前置为什么不会自己合回：写给父对话看 */
function predWhy(p: AfterPred | undefined) {
  if (!p || taskDeleted(p)) return '已经删除'
  if (p.archived) return '已经归档'
  if (p.status === 'failed') return '执行失败了'
  return '已经中断、不会自己接着做'
}

/**
 * 校验 create_conversation 的 after：只能写同一个父对话名下、已经建好的子对话 id。去重、去空；
 * 新建的子对话还没有 id，别人不可能排在它后面，所以不会成环
 */
export function checkAfter(
  ids: string[],
  kids: (AfterPred & Pick<Task, 'parentTaskId'>)[],
  parentId: string,
): { ok: true; ids: string[] } | { ok: false; info: string } {
  const list = [...new Set(ids.map((x) => x.trim()).filter(Boolean))]
  const unknown = list.filter((id) => !kids.some((k) => k.id === id && k.parentTaskId === parentId && !taskDeleted(k)))
  if (unknown.length)
    return {
      ok: false,
      info: `after 里的 ${unknown.join('、')} 不是你名下的子对话：只能写 list_conversations 列出的子对话 id`,
    }
  return { ok: true, ids: list }
}
