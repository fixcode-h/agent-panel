import { PLAN_STALE_MS, activePlan, itemStale, itemUpdatedAt, runningItem } from './plan.ts'
import type { Task } from './schema.ts'

// 放在单独的文件里：shared/plan.ts 到了行数上限（scripts/file-caps.json）

/**
 * 计划没跟上提醒（内置钩子 plan-pace，工具后）：对话一股脑做完再补计划时，在这一轮中间就拉它回来更新。
 * 以前只在一轮开头（planNotice）和结尾（keep-going）提醒，子对话常常一整轮就把活干完，中间没人提醒。
 * 只看工具调用的类别和计划状态，不看回复文字（ADR 0041、0049）。两种情况补一句，同一种情况最多补设置的次数（默认 1），
 * 每补一次重新数，再动手到次数才补下一次：
 * - 有没开始的步骤、却没有进行中的步骤，对话在改文件、跑命令：先把正在做的那一步标进行中
 * - 进行中的那一项很久没动：改文件、跑命令累计到设置的次数；或者超过滞后阈值（PLAN_STALE_MS）、
 *   期间也动过手（次数的三分之一）——光是时间长不算（跑一条慢测试正常），一直在动手却不更新才算
 */

/** 每个对话一份：现在数的是哪一项、它上次变化（或上次提醒）以后动了几次手，以及每种情况提醒过几次 */
export interface PaceState {
  key: string
  stamp: number | undefined
  calls: number
  hinted: Map<string, number>
}

export const newPace = (): PaceState => ({ key: '', stamp: undefined, calls: 0, hinted: new Map() })

/** 默认动手几次就提醒：计划步骤一般不分太细，一步里改十几处文件、跑几次检查是常见的，过了 20 次多半是几步连着做了 */
export const PACE_CALLS = 20
/** 同一步默认最多提醒几次：提醒过一次还不更新，多半是这一步本来就大，再催只是打断 */
export const PACE_TIMES = 1

/** 算「动手」的工具：改文件、跑命令。读文件、搜代码是摸情况，面板自己的工具（set_plan 这些）不算 */
const WORK = new Set(['edit', 'shell']) // 模块状态：常量，加载后不改

export function planPaceHint(
  task: Pick<Task, 'plans' | 'steps'>,
  kind: string,
  state: PaceState,
  calls = PACE_CALLS,
  times = PACE_TIMES,
  now = Date.now(),
): string {
  if (!WORK.has(kind)) return ''
  const plan = activePlan(task)
  if (!plan) return ''
  const cur = runningItem(task)
  // 数的对象换了（换了一步、或者这一步被更新过）就从头数：Agent 动过计划说明它在跟
  const key = cur ? `${plan.id}:${cur.item.id}:${cur.item.startedAt}` : `${plan.id}:none`
  const stamp = cur ? itemUpdatedAt(cur.item) : Date.parse(plan.updatedAt || plan.createdAt || '')
  if (state.key !== key || state.stamp !== stamp) Object.assign(state, { key, stamp, calls: 0 })
  state.calls++
  const told = state.hinted.get(key) ?? 0
  if (told >= Math.max(1, times)) return ''
  // 提醒过就从头数：设了多次时，再动手到次数才提醒下一次
  const hint = (text: string) => {
    state.hinted.set(key, told + 1)
    state.calls = 0
    return text
  }
  if (!cur) {
    // 都在等结果、或者都做完了：这时动手多半是在处理推回来的结果，不催
    const pending = plan.steps.flatMap((s) => [s, ...s.children]).find((x) => x.status === 'pending')
    if (!pending || state.calls < 3) return ''
    return hint(
      '【面板】计划里现在没有进行中的步骤，你却在改文件、跑命令：先用 set_plan（partial: true，带步骤 id）把正在做的那一步标成进行中，已经做完的标完成，再接着做。',
    )
  }
  const stale = itemStale(cur.item, now) !== undefined && state.calls >= Math.max(1, Math.ceil(calls / 3))
  if (state.calls < Math.max(1, calls) && !stale) return ''
  const how = stale
    ? `超过 ${Math.round(PLAN_STALE_MS / 60_000)} 分钟、改文件和跑命令 ${state.calls} 次`
    : `改文件和跑命令 ${state.calls} 次`
  return hint(
    `【面板】计划里「${cur.item.title}」上次更新以后，已经${how}，计划没再动过。这一步做完了就马上用 set_plan（partial: true，带步骤 id）标完成、把下一步标进行中，再接着做；不要几步做完再一起补。这一步确实还没做完就接着做，不用回复这句。`,
  )
}
