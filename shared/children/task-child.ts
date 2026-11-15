import type { TaskChild } from '../schema.ts'
import { liftFields } from '../tasks/lift-fields.ts'

/**
 * 写子对话的数据（task.child，见 schema.ts 的 TaskChild）：整个换掉子对象，不就地改。
 * 调用方手里常是一份浅拷贝（{ ...task }）：就地改 task.child.x 会连带改到列表缓存、推送比对里的旧对象，
 * 新旧比不出差别。值写 undefined 表示清掉这一项
 */
export function setChild(t: { child?: TaskChild }, patch: Partial<TaskChild>): void {
  // 只是清空（写 undefined、空列表）而本来就没有 task.child：不凭空给顶层对话造一个空的子对象
  const clearing = Object.values(patch).every((v) => v === undefined || (Array.isArray(v) && !v.length))
  if (clearing && !t.child) return
  t.child = { ...t.child, ...patch }
}

/** 旧格式平铺在 Task 顶层、只有子对话用的字段：收进 task.child 后键名不变 */
const LEGACY_KEYS = Object.fromEntries(
  ['wrapRequest', 'buildAsk', 'handoff', 'pendingReport', 'userDirect', 'parentAsks', 'autoAsk'].map((k) => [k, k]),
)

/**
 * 把旧格式的原始任务 JSON 就地改成 task.child 子对象，返回改没改；空的提问列表、空串直接丢掉。
 * 只给一次性迁移（server/migrations/0010-task-child.ts）和导入旧导出文件用，读任务时不再调
 */
export const liftChildFields = (raw: Record<string, unknown>): boolean =>
  liftFields(raw, 'child', LEGACY_KEYS, (_to, v) => v === '' || (Array.isArray(v) && !v.length))
