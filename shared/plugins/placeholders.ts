import type { PluginConfig } from './types.ts'

/**
 * 插件接口 11 清单值里的占位符（runtime-schema.ts）：`{config.<key>}` 插件参数、`{port}` 托管进程的端口、
 * `{dir}` 插件包目录、`{data}` 插件数据目录。认不出的原样留着（交给 CLI 的值可能本来就带花括号）
 */
export interface PlaceholderVars {
  config: PluginConfig
  dir: string
  data: string
  port?: number
}

export function fillPlaceholders(text: string, v: PlaceholderVars): string {
  return text.replace(/\{(config\.([\w.-]+)|port|dir|data)\}/g, (all, _k: string, key: string | undefined) => {
    if (key !== undefined) return key in v.config ? String(v.config[key]) : ''
    if (all === '{port}') return v.port === undefined ? all : String(v.port)
    return all === '{dir}' ? v.dir : v.data
  })
}

/** 值里用到的插件参数却没填（空字符串）：跑之前能提示「先在插件页填 xx」 */
export function missingConfig(text: string, config: PluginConfig): string[] {
  return [...text.matchAll(/\{config\.([\w.-]+)\}/g)]
    .map((m) => m[1])
    .filter((k) => config[k] === undefined || config[k] === '')
}
