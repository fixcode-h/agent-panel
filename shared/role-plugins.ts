import { z } from 'zod'
import type { CliDefinition } from './clis.ts'

/**
 * 角色级插件（ADR 0050 第四期）：某个角色执行时额外加载的 CLI 插件，不装进 CLI 的全局配置。
 * 例如「测试」角色带代码诊断插件、「调研」角色带联网搜索，别的角色不带，工具清单更短、更省上下文。
 * CLI 定义里写了 packages.oneOff（Pi：-e {source}）才生效；角色换成别的 CLI 时这些来源不传
 */
export const RolePlugins = z.array(z.string().trim().min(1).max(200)).max(10).optional()

/** 这个角色这次执行要加的参数 */
export function pluginArgs(def: Pick<CliDefinition, 'packages'> | undefined, plugins: string[] | undefined): string[] {
  const tpl = def?.packages?.oneOff
  if (!tpl?.length || !plugins?.length) return []
  return [...new Set(plugins.map((x) => x.trim()).filter(Boolean))].flatMap((source) =>
    tpl.map((a) => a.replaceAll('{source}', source)),
  )
}
