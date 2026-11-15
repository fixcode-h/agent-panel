import { liftAnalysisFields } from '../../shared/tasks/task-analysis.ts'
import type { Migration } from './index.ts'
import { liftTaskFiles } from './lift-tasks.ts'

/**
 * 任务记录上平铺的 AI 分析字段（analysis 种类、analysisOf）收进 task.analysis 子对象，旧的 modelDesign 转成
 * plugin: 'blender.model'（复查报告 A7，格式见 shared/tasks/task-analysis.ts）。只改原始 JSON 上的这几个键，别的原样；没有要改的不写盘
 */
export const taskAnalysis: Migration = {
  version: 9,
  name: 'task-analysis',
  async run(ctx) {
    const n = await liftTaskFiles(ctx, liftAnalysisFields)
    if (n) ctx.log(`把 ${n} 个任务记录的分析字段收进了 task.analysis`)
  },
}
