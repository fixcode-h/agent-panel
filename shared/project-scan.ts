/**
 * 新建项目时「AI 分析」的结果：读本地目录得出的事实，填进项目表单，用户确认后才保存。
 * 前后端共用这个结构（演示版也用它）。
 */
import type { TestStep } from './schema.ts'

export interface ProjectSuggestion {
  name: string
  description: string
  /** 建议用哪个项目工作流：general 是「通用项目」，ue 是「UE 项目」 */
  workflow: 'general' | 'ue'
  /** 填进 Project.workflowParams 的配置项 */
  workflowParams: Record<string, string>
  /** 按识别出的技术栈给的默认测试步骤，填进 Project.testSteps */
  testSteps: TestStep[]
  /** 标了 WSL 的步骤用的发行版；没有 WSL 步骤时为空 */
  wslDistro: string
  /** 建议的项目分类名（没有就空） */
  category: string
  /** 分析依据，展示给用户看，不进项目数据 */
  signals: string[]
}
