import { z } from 'zod'

/**
 * 风格库的结构（从 shared/design.ts 拆出）：风格库是面板的（设置 →「风格」、对话输入框选风格），
 * UI 设计拆成插件后也照样用它，所以结构留在面板这边，设计代码从 shared/design.ts 转出去用。
 */
export const DESIGN_KINDS = ['game', 'web'] as const
export type DesignKind = (typeof DESIGN_KINDS)[number]

/**
 * 项目提示词的分类：界面上显示中文，发给生图 AI 时用英文。
 */
export const PROMPT_CATEGORIES = ['style', 'color', 'material', 'light', 'layout', 'avoid'] as const
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number]
export const PROMPT_CATEGORY_LABEL: Record<PromptCategory, string> = {
  style: '画风',
  color: '色彩',
  material: '材质',
  light: '光影',
  layout: '构图',
  avoid: '避免',
}

/**
 * 风格库：从做好的设计里让 CLI 总结出来的整体风格，存在设置里，别的项目、别的设计可以直接套用。
 * summary 是给人看的中文说明，en 是发给设计 AI 和生图 AI 的英文；prompts 套用到 UI 项目的美术提示词
 */
export const StylePrompt = z.object({
  category: z.enum(PROMPT_CATEGORIES).catch('style'),
  zh: z.string().trim().max(200),
  en: z.string().trim().max(300),
})
export const SavedStyleInput = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(DESIGN_KINDS).default('game'),
  summary: z.string().trim().max(500).default(''),
  en: z.string().trim().max(4000).default(''),
  prompts: z.array(StylePrompt).max(30).default([]),
})
export type SavedStyleInput = z.input<typeof SavedStyleInput>
export const SavedStyle = SavedStyleInput.extend({
  id: z.string(),
  /** 程序内置的风格（shared/styles.ts）：只读，可以复制成自己的再改 */
  builtin: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SavedStyle = z.infer<typeof SavedStyle>
