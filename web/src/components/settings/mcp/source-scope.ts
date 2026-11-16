import type { CatalogSource } from '@shared/mcp-catalog/types'
import { t } from '@shared/i18n'

/**
 * 插件来源的生效范围（插件接口 9）：全局的对所有项目的对话都挂；按项目的只在项目「能力」里打开了的项目挂。
 * 卡片和来源页都写这一句，免得只看到「插件已开启」，却不知道哪个项目的对话才拿得到这些工具
 */
export function sourceScope(s: CatalogSource): { short: string; long: string; off: boolean } | undefined {
  if (s.kind !== 'plugin' || !s.activation) return undefined
  if (s.activation === 'global') return { short: t('全局'), long: t('所有项目'), off: false }
  const names = s.projects ?? []
  if (!names.length)
    return {
      short: t('按项目 · 还没有项目打开'),
      long: t('按项目：还没有项目打开，在项目设置 →「能力」里打开'),
      off: true,
    }
  return {
    short: t('按项目 · {n} 个项目打开', { n: names.length }),
    long: t('按项目：{names}', { names: names.join(t('、')) }),
    off: false,
  }
}
