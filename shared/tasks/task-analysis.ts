import { z } from 'zod'
import { liftFields } from './lift-fields.ts'

/**
 * AI 分析对话的种类（见 ADR 0014、0016）：标题在列表里和别的对话区分开，右侧功能面板按种类挑内容。
 * run：分析执行记录（对话、子任务、几次工作流执行）；init：AI 初始化项目；lessons：教训评审；fix：AI 排查报错
 */
export const AnalysisKind = z.enum(['run', 'init', 'lessons', 'fix'])
export type AnalysisKind = z.infer<typeof AnalysisKind>

/**
 * AI 分析开出的对话记的是哪种分析、分析的是哪个对话（复查报告 A7）：原来平铺在 Task 顶层（analysis 是种类、analysisOf 是对象），
 * 收进 task.analysis 一个子对象。普通对话没有 task.analysis。
 * 旧数据由 server/migrations/0009-task-analysis.ts 一次性转过来，旧导出文件导入时由 liftAnalysisFields 转。
 */
export const TaskAnalysis = z.object({
  kind: AnalysisKind,
  /** 分析的是哪个对话（「在当前对话里修」发回它）；旧数据、和对话无关的分析没有（原 task.analysisOf） */
  of: z.string().optional(),
})
export type TaskAnalysis = z.infer<typeof TaskAnalysis>

/** 旧版的模型设计对话（ADR 0025，modelDesign: true）现在归 Blender 插件的这个设计模式（ADR 0059） */
const MODEL_DESIGN_PLUGIN = 'blender.model'

/**
 * 把旧格式的原始任务 JSON 就地改成新格式，返回改没改：analysis（种类字符串）、analysisOf 收进 task.analysis；
 * 旧的 modelDesign: true 转成 plugin: 'blender.model'（已经有 plugin 的不覆盖）后去掉。
 * 只有 analysisOf、没有种类的不成一个分析对话，丢掉。只给一次性迁移和导入旧导出文件用，读任务时不再调
 */
export function liftAnalysisFields(raw: Record<string, unknown>): boolean {
  let changed = liftFields(raw, 'analysis', { analysis: 'kind', analysisOf: 'of' })
  const a = raw.analysis as Record<string, unknown> | undefined
  if (a && typeof a.kind !== 'string') delete raw.analysis // delete-ok: 原始 JSON 对象，不是经 store.update 合并的 Task
  if ('modelDesign' in raw) {
    if (raw.modelDesign === true && !raw.plugin) raw.plugin = MODEL_DESIGN_PLUGIN
    delete raw.modelDesign // delete-ok: 同上
    changed = true
  }
  return changed
}
