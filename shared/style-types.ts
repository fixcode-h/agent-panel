import { z } from 'zod'

/**
 * 风格库的结构（从 shared/design.ts 拆出）：风格库是面板的（设置 →「风格」、对话输入框选风格），
 * UI 设计拆成插件后也照样用它，所以结构留在面板这边，设计代码从 shared/design.ts 转出去用。
 */
export const DESIGN_KINDS = ['game', 'web'] as const
export type DesignKind = (typeof DESIGN_KINDS)[number]
/**
 * 风格库里风格的类别：UI 设计的两类之外加「3D 模型」（Blender 建模用）。
 * 设计本身的类别还是 DESIGN_KINDS，模型风格不会出现在设计的风格选项里
 */
export const STYLE_KINDS = [...DESIGN_KINDS, 'model'] as const
export type StyleKind = (typeof STYLE_KINDS)[number]

/**
 * 3D 模型风格的约束组：不同风格约束的方面不一样（卡通看描边、机械看结构），每个风格只写和它有关的组。
 * 每组若干条中文要点，按这个顺序拼成给 Agent 的说明（shared/style/rules-text.ts）
 */
export const RULE_GROUPS = [
  'shape',
  'proportion',
  'topology',
  'detail',
  'structure',
  'material',
  'outline',
  'check',
  'avoid',
] as const
export type RuleGroup = (typeof RULE_GROUPS)[number]
export const RULE_GROUP_LABEL: Record<RuleGroup, string> = {
  shape: '造型',
  proportion: '比例',
  topology: '拓扑',
  detail: '细节',
  structure: '结构',
  material: '材质与着色',
  outline: '描边',
  check: '验收',
  avoid: '避免',
}
export const StyleRule = z.object({
  group: z.enum(RULE_GROUPS).catch('detail'),
  text: z.string().trim().min(1).max(400),
})
export type StyleRule = z.infer<typeof StyleRule>

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
  kind: z.enum(STYLE_KINDS).default('game'),
  summary: z.string().trim().max(500).default(''),
  en: z.string().trim().max(4000).default(''),
  prompts: z.array(StylePrompt).max(30).default([]),
  /** 3D 模型风格的约束要点（按约束组），UI 风格不用 */
  rules: z.array(StyleRule).max(80).default([]),
  /**
   * 参考图：内置风格是程序自带的图（按 id 找，这里留空）；自己的风格是上传后存在数据目录 styles/ 下的文件名，
   * 经 /api/styles/<id>/image 取。只用来给人看，不发给 AI
   */
  image: z.string().max(200).default(''),
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
