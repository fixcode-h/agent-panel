/**
 * 从 GitHub 链接包装插件的接口契约（写法见 ./define.ts，说明见 ADR 0068、server/plugins/wrap/）。
 * 预览返回的前半部分和其他安装方式的预览一样（token、manifest、scan…，确认走 /plugins/install/confirm），
 * wrap 里是包装专有的：识别结果、会做什么、生效范围、更新时的变化
 */
import { z } from 'zod'
import { ConfigFinding } from '../config-scan/index.ts'
import { WrapCandidate, WrapOrigin, WrapRecipe, WrapStep } from '../plugins/wrap/recipe.ts'
import { endpoint, shaped } from './define.ts'

export const WrapPreviewInput = z.object({
  /** GitHub 链接或 owner/repo */
  url: z.string().trim().min(1).max(300),
  /** 预览里勾选的识别项（候选的 key）；不传按默认勾选 */
  picks: z.array(z.string()).max(50).optional(),
  activation: z.enum(['global', 'project']).optional(),
  /** 「AI 帮我包装」产出的配方：传了就按它，不再查社区配方和识别 */
  recipe: WrapRecipe.optional(),
  /** 更新已装的包装插件：沿用安装时的配方和勾选，并比出权限变化和新增发现 */
  update: z.boolean().optional(),
})
export type WrapPreviewInput = z.infer<typeof WrapPreviewInput>

/** 包装专有的预览内容 */
export const WrapInfo = z.object({
  repo: z.string(),
  ref: z.string(),
  commit: z.string(),
  date: z.string(),
  license: z.string(),
  description: z.string(),
  origin: WrapOrigin,
  /** 用的社区配方文件（origin 为 recipe 时） */
  recipeFile: z.string().optional(),
  /** 来源分级：community 是插件市场审核过的配方，any 是任意链接 */
  trust: z.enum(['official', 'community', 'any']),
  candidates: z.array(WrapCandidate),
  picks: z.array(z.string()),
  /** 能不能改勾选（按配方的不能改） */
  editable: z.boolean(),
  /** 什么都没认出来：给「AI 帮我包装」 */
  unrecognized: z.boolean(),
  steps: z.array(WrapStep),
  stats: z.object({ files: z.number(), bytes: z.number() }),
  activation: z.enum(['global', 'project']),
  /** 按内容建议的生效范围（设计稿 7.2 第 6 条） */
  suggested: z.enum(['global', 'project']),
  /** 最后生效的配方：界面不改它，「AI 帮我包装」修正时回传 */
  recipe: WrapRecipe.optional(),
  /** 更新时：和装着的那一版比，多出来的权限和扫描发现；blocked 为真时一键更新跳过 */
  update: z
    .object({
      from: z.string(),
      permChanges: z.array(z.string()),
      newFindings: z.array(ConfigFinding),
      blocked: z.boolean(),
    })
    .optional(),
})
export type WrapInfo = z.infer<typeof WrapInfo>

export interface WrapPreview {
  /** 认不出来时为空：不能确认安装 */
  token: string
  manifest?: unknown
  scan: ConfigFinding[]
  scanScope?: string
  hasCode: boolean
  installed: { version: string } | null
  requires?: { id: string; name: string; current?: string; latest: string }[]
  wrap: WrapInfo
}

export const pluginWrapContract = {
  preview: endpoint({
    method: 'POST',
    path: '/plugins/wrap/preview',
    body: WrapPreviewInput,
    res: shaped<WrapPreview>(z.looseObject({ token: z.string(), scan: z.array(ConfigFinding), wrap: WrapInfo })),
  }),
  /** 「AI 帮我包装」：服务端读好仓库（不执行），拼出给分析对话的提示词 */
  aiPrompt: endpoint({
    method: 'POST',
    path: '/plugins/wrap/ai-prompt',
    body: z.object({ url: z.string().trim().min(1).max(300) }),
    res: z.object({ prompt: z.string() }),
  }),
  /** 分析对话的最后一条回复 → 配方；格式不对返回 error（对话会自己修正一次） */
  aiResolve: endpoint({
    method: 'POST',
    path: '/plugins/wrap/ai-resolve',
    body: z.object({ url: z.string().trim().min(1).max(300), text: z.string().max(200_000) }),
    res: z.object({ recipe: WrapRecipe.optional(), error: z.string().optional() }),
  }),
}
