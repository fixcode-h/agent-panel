import { randomUUID } from 'node:crypto'
import { budgetLevel, budgetNote, budgetUse, type BudgetLevel } from '../../shared/budget.ts'
import type { Task } from '../../shared/schema.ts'
import { wakeHold, type WakeHold } from '../../shared/wake.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'

/**
 * 父对话的用量上限（见 shared/budget.ts）：每一轮结束时按整棵对话树核一次。
 * 过了提醒线在顶层对话里说一次；到了上限停下树上所有还在跑的对话（StopReason 'budget'），也只说一次。
 * 到上限后用户再发消息照样跑一轮（那是用户自己要的），跑完这里又会停下；调高上限后提醒级别跟着回落。
 */
export function createBudget(s: TasksScope) {
  /** 顶层对话：顺着 parentTaskId 往上找，断了（父对话被删）就停在最后一个能找到的 */
  async function rootOf(tk: Task): Promise<Task> {
    let cur = tk
    const seen = new Set<string>([cur.id])
    while (cur.parentTaskId && !seen.has(cur.parentTaskId)) {
      const up = s.live.get(cur.parentTaskId)?.task ?? (await s.store.get(cur.parentTaskId))
      if (!up) break
      seen.add(up.id)
      cur = up
    }
    return cur
  }

  /** 按整棵树现算一次用量和级别（只读）；顶层对话没有项目时为空 */
  async function measure(tk: Task) {
    const root = await rootOf(tk)
    if (!root.projectId) return undefined
    const budget = (await s.deps.projects.get(root.projectId))?.budget
    // 列表里的用量最多落后一次落盘：在跑的对话用内存里那一份
    const all = (await s.store.list()).map((x) => s.live.get(x.id)?.task ?? x)
    const use = budgetUse(root.id, all)
    return { root, budget, all, use, level: budgetLevel(use, budget) }
  }

  /**
   * tk 所在的对话树是不是已经用到上限：只判断、不停任何东西，叫醒对话之前用（见 holdWake）。
   * 父对话超限时如果是空闲的，checkBudget 不会把它记成 budget，只看它的 stopReason 挡不住，要现算。
   * 核不出来按没超限算，和 checkBudget 一样不挡对话
   */
  async function overBudget(tk: Task): Promise<boolean> {
    try {
      return (await measure(tk))?.level === 'over'
    } catch (e) {
      log.warn('task', '核对用量上限失败', { task: tk.id, error: (e as Error).message })
      return false
    }
  }

  /**
   * 面板要替别人叫醒 target（开新的一轮）之前过这一道（规则在 shared/wake.ts 的 wakeHold）：返回不叫的原因。
   * from：发这条消息的子对话 id（它自己正在被停下时这条不叫）；fromAbove：父对话 / 面板交给子对话的
   */
  async function holdWake(
    target: Task,
    opts: { from?: string; fromAbove?: boolean } = {},
  ): Promise<WakeHold | undefined> {
    const live = s.live.get(target.id)
    const kid = opts.from ? s.live.get(opts.from) : undefined
    const cur = live?.task ?? target
    return wakeHold({
      status: cur.status,
      stopReason: cur.stopReason,
      live: live && { stop: live.stop, stopReason: live.stopReason },
      sender: kid && { stop: kid.stop, stopReason: kid.stopReason },
      overBudget: await overBudget(cur),
      fromAbove: opts.fromAbove,
    })
  }

  /**
   * 一轮结束后核一次；返回 true 表示到了上限、已经停下（调用方别再推它接着做）。
   * 出错只记日志、按没到上限算：核不出来不该挡住对话
   */
  async function checkBudget(tk: Task): Promise<boolean> {
    try {
      const m = await measure(tk)
      if (!m) return false
      const { root, budget, all, use, level } = m
      if (level === 'over') {
        for (const x of all) if (s.live.has(x.id) && inTree(x, root.id, all)) s.stopTask(x.id, 'budget')
      }
      await notice(
        root.id,
        level,
        (level === 'warn' || level === 'over') && budget ? budgetNote(level, use, budget) : '',
      )
      return level === 'over'
    } catch (e) {
      log.warn('task', '核对用量上限失败', { task: tk.id, error: (e as Error).message })
      return false
    }
  }

  /** 记下提醒到了哪一级：升级时在顶层对话里写一条，回落（调高了上限）时只清标记 */
  async function notice(rootId: string, level: BudgetLevel, text: string) {
    const entry = s.live.get(rootId)
    const tk = entry?.task ?? (await s.store.get(rootId))
    if (!tk) return
    const want = level === 'warn' || level === 'over' ? level : undefined
    if (tk.budgetNotice === want) return
    const rank = (x?: string) => (x === 'over' ? 2 : x === 'warn' ? 1 : 0)
    const up = rank(want) > rank(tk.budgetNotice)
    tk.budgetNotice = want
    if (up && text) {
      const at = new Date().toISOString()
      tk.messages.push({ id: randomUUID(), role: 'system', agentId: '', step: '', text, tools: [], at })
      tk.updatedAt = at
    }
    if (entry) entry.rev++
    await s.store.update(rootId, tk)
  }

  return { checkBudget, holdWake, overBudget }
}

/** x 是不是 rootId 这棵对话树上的（含它自己） */
function inTree(x: Task, rootId: string, all: Task[]): boolean {
  const byId = new Map(all.map((t) => [t.id, t]))
  const seen = new Set<string>()
  for (let cur: Task | undefined = x; cur && !seen.has(cur.id); cur = byId.get(cur.parentTaskId ?? '')) {
    if (cur.id === rootId) return true
    seen.add(cur.id)
  }
  return false
}
