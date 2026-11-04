import { z } from 'zod'

/**
 * 一条参数规则：条件都满足时加上 args。
 * if：「model」有值、「!resume」没值、「permission=yolo」等于、「permission!=yolo」不等于；多个条件写成数组，全部满足才加
 * args 里的占位：{model}、{effort}、{permission}、{resume}、{systemPrompt}、{maxTurns}、{title}；
 * {addDirs|,} 把数组用逗号连起来；{maxTurns:200} 没值时用 200。each：对数组的每一项加一次，{item} 是那一项
 */
export const ArgRule = z.object({
  if: z.union([z.string(), z.array(z.string())]).optional(),
  each: z.enum(['addDirs']).optional(),
  args: z.array(z.string()),
  /** 为什么这样传（JSON 里没法写注释，写在这里），面板不读 */
  why: z.string().optional(),
})
export type ArgRule = z.infer<typeof ArgRule>
