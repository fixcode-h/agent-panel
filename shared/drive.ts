import type { TaskPlan } from './schema.ts'

/**
 * 对话自驱（ADR 0041）的共用规则。这一版先放「进度指纹」：面板推对话接着做的次数按它算，
 * 指纹变了（计划有实质变化）就从头数。
 *
 * 原来的 key 只是「计划 id:已完成几步」：计划加了步骤、某步从待做变进行中都算「没进展」，
 * 推满 3 次后同一进度再也不推（用户 2026-11-02 报：计划没做完就停在那里）。
 * 指纹只看步骤的 id 和状态：只改备注、改标题不算进展，免得模型反复改一个字刷新次数。
 */
export function planProgressKey(plan: Pick<TaskPlan, 'id' | 'steps'>): string {
  const items = plan.steps.flatMap((s) => [
    `${s.id}:${s.status}`,
    ...(s.children ?? []).map((c) => `${s.id}/${c.id}:${c.status}`),
  ])
  return `${plan.id}|${items.join(',')}`
}

/** 日志里写的短指纹：完整的 key 可能很长，排查时只要能看出变没变 */
export function shortKey(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
