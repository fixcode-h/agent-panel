import type { ModelCatalogEntry } from './catalog.ts'

/**
 * CLI 不报费用时按模型目录里填的单价折算（设计报告 Agent P1-4）。Claude Code、Pi 自己报 costUsd，
 * 照旧用它们报的；Codex、Command Code 不报，以前 costUsd 一直是 0，项目「按费用的上限」对它们不起作用。
 * 单价是用户填的（ModelCatalogEntry.price，美元 / 百万 token），没填就返回 0，界面写「费用未知」
 */
export function priceCost(
  price: ModelCatalogEntry['price'],
  use: { addInput?: number; addOutput?: number; addCacheRead?: number; addCacheWrite?: number },
): number {
  if (!price) return 0
  const m = 1_000_000
  return (
    ((use.addInput ?? 0) * price.input +
      (use.addOutput ?? 0) * price.output +
      (use.addCacheRead ?? 0) * price.cacheRead +
      (use.addCacheWrite ?? 0) * price.cacheWrite) /
    m
  )
}
