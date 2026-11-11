import { t } from '../i18n.ts'
import HOST_MODULES from './host-modules.json'
import type { PluginManifest } from './types.ts'

/**
 * 插件用到的开放模块，这个面板开放了没有（插件框架改进 B1）。插件仓库按面板 dev 的清单构建，用户跑的可能是更早的正式版：
 * 新开放的模块旧面板没有，以前要等运行到 import 那一行才报「面板没有开放模块」。插件构建时把用到的写进清单 hostModules，
 * 这里安装预览、启动时就核对，缺了直接拒绝并写明要先升级面板。第三方包（zod）在 <端>Packages 里。
 */
type Side = 'web' | 'server'
const LIST = HOST_MODULES as Record<string, string[] | undefined>

export function missingHostModules(
  m: Pick<PluginManifest, 'hostModules'>,
  list: Record<string, string[] | undefined> = LIST,
) {
  const out: string[] = []
  for (const side of ['web', 'server'] as Side[]) {
    const have = new Set([...(list[side] ?? []), ...(list[`${side}Packages`] ?? [])])
    for (const key of m.hostModules?.[side] ?? []) if (!have.has(key)) out.push(`${side}:${key}`)
  }
  return out
}

/** 缺模块时的报错：只列前几个，后面写个数 */
export function hostModulesError(missing: string[]) {
  if (!missing.length) return ''
  const shown = missing.slice(0, 5).join(t('、'))
  return t('插件要用面板的模块 {list}{more}，这个版本的面板没有开放，请先升级面板', {
    list: shown,
    more: missing.length > 5 ? t(' 等 {n} 个', { n: missing.length }) : '',
  })
}
