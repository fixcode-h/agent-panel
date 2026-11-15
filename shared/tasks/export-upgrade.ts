import { liftBugFields } from '../bug/task-bug.ts'
import { liftAnalysisFields } from './task-analysis.ts'
import { liftBudgetFields } from './task-budget.ts'

/**
 * 每一版导出格式要对任务和子对话做的转换：[转到第几版, 就地改原始任务 JSON 的函数]，和数据目录的迁移一一对应。
 * 导出文件不在数据目录里，数据目录的一次性迁移管不到，只能在导入时转
 */
const EXPORT_UPGRADES: [number, (tk: Record<string, unknown>) => unknown][] = [
  [2, liftBugFields], // 平铺的 Bug 字段收进 task.bug（重构文档第 15 条，迁移 0004）
  [3, liftBudgetFields], // 平铺的执行上限字段收进 task.budget（复查报告 A7，迁移 0008）
  [4, liftAnalysisFields], // 平铺的分析字段收进 task.analysis，modelDesign 转成 plugin（复查报告 A7，迁移 0009）
]

/** 导出文件的格式版本：最后一次转换转到的那一版 */
export const TASK_EXPORT_VERSION = EXPORT_UPGRADES.at(-1)![0]

/** 旧版本导出的文件转成当前格式（不改传入的对象）：按 EXPORT_UPGRADES 逐版转 */
export function upgradeExport(o: Record<string, unknown>): Record<string, unknown> {
  const from = typeof o.version === 'number' ? o.version : TASK_EXPORT_VERSION
  if (from >= TASK_EXPORT_VERSION) return o
  const copy = structuredClone(o)
  for (const tk of [copy.task, ...(Array.isArray(copy.children) ? copy.children : [])])
    if (tk && typeof tk === 'object')
      for (const [to, up] of EXPORT_UPGRADES) if (to > from) up(tk as Record<string, unknown>)
  return { ...copy, version: TASK_EXPORT_VERSION }
}
