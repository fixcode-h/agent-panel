import { activePlan, settleWait } from './plan.ts'
import type { PlanWait, Task } from './schema.ts'

// 放在单独的文件里：shared/plan.ts 到了行数上限（scripts/file-caps.json）

/**
 * 结果不会再来的等待（面板崩溃，后台命令的记录跟着进程没了）按「没成功」收口：那一步退回进行中、写「需要修复」，
 * 不收就永远「等待中」，planStalled 也不推。known：面板还认得、结果会推回来的 ref。返回收了几条
 */
export function failLostWaits(
  task: Pick<Task, 'plans' | 'steps'>,
  kind: PlanWait['kind'],
  known: (ref: string) => boolean,
) {
  const waits = activePlan(task)?.steps.flatMap((s) => [s, ...s.children].flatMap((x) => x.waits)) ?? []
  const lost = waits.filter((w) => w.kind === kind && w.state === 'waiting' && !known(w.ref))
  return [...new Set(lost.map((w) => w.ref))].filter((ref) => settleWait(task, kind, ref, false).length).length
}
