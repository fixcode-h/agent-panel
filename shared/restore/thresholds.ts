import { z } from 'zod'

/**
 * 原画还原的门槛（设置 → UI 设计里可以调）：
 * - posPx：控件和原画里同一个元素的位置、大小差多少像素以内算对上（设计稿像素）
 * - posRatio：对上的元素要占多少才算这一版过关
 * - assetSim：切图和原画那一块的相似度至少多少；精修出来的低于它不选用
 * - parts：切图前先让图片模型照原画出一张拆件图，从拆件图切（干净、不夹带别的 UI）；关掉就直接从原画抠
 */
export const RestoreThresholds = z.object({
  posPx: z.number().min(0).max(20).catch(2).default(2),
  posRatio: z.number().min(0.5).max(1).catch(0.95).default(0.95),
  assetSim: z.number().min(0.5).max(1).catch(0.92).default(0.92),
  parts: z.boolean().catch(true).default(true),
})
export type RestoreThresholds = z.infer<typeof RestoreThresholds>
export const DEFAULT_THRESHOLDS: RestoreThresholds = { posPx: 2, posRatio: 0.95, assetSim: 0.92, parts: true }
