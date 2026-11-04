import { z } from 'zod'

/**
 * CLI 插件的细项开关（ADR 0050 第四期），都写在 CLI 自己的配置文件里、只动相关的那一项：
 * - resources：一个包里按类型开关（扩展 / Skill / 提示词 / 主题）。Pi 的 packages 支持对象写法
 *   `{ "source", "skills": [] }`：某类写空数组就是这类一个都不加载，不写就是全加载
 * - builtins：CLI 自带、默认加载的扩展（Pi 的 builtin:mcp 等），在 key 数组里写 off（-builtin:mcp）就不加载
 * - local：装到项目里（Pi 的 pi install -l，写进项目的 .pi/settings.json），只有这个项目的对话加载
 */
export const PackageResources = z.object({
  /** 包的 package.json 里放 CLI 字段的键（Pi 是 pi），里面按类型列资源 */
  manifestKey: z.string(),
  /** 类型 → 界面文案；包里没写 manifest 时按同名目录判断有没有 */
  types: z.record(z.string(), z.string()),
})
export type PackageResources = z.infer<typeof PackageResources>

export const BuiltinExtensions = z.object({
  /** 配置文件里的数组键（Pi 的 settings.json 是 extensions） */
  key: z.string(),
  /** 关掉一个时写进数组的值，{id} 换成名字 */
  off: z.string(),
  items: z.array(z.object({ id: z.string().min(1), label: z.string(), hint: z.string().default('') })),
})
export type BuiltinExtensions = z.infer<typeof BuiltinExtensions>

export const LocalPackages = z.object({
  /** 项目里的配置文件（相对项目目录） */
  file: z.string(),
  install: z.array(z.string()).min(1),
  remove: z.array(z.string()).min(1),
})
export type LocalPackages = z.infer<typeof LocalPackages>

type Entry = string | ({ source: string } & Record<string, unknown>)
const sourceOf = (e: unknown) =>
  typeof e === 'string'
    ? e
    : typeof (e as { source?: unknown })?.source === 'string'
      ? (e as { source: string }).source
      : ''

/** 包里各类资源现在开没开：对象写法里写了空数组的算关 */
export function resourceState(entry: unknown, types: string[]): Record<string, boolean> {
  const obj = typeof entry === 'object' && entry ? (entry as Record<string, unknown>) : {}
  return Object.fromEntries(types.map((t) => [t, !(Array.isArray(obj[t]) && (obj[t] as unknown[]).length === 0)]))
}

/**
 * 改一个包的一类资源（原地改 list）：关掉写空数组，打开删掉这一项（全加载）；
 * 改完只剩 source 的对象写回字符串。别的类型、用户手写的筛选（非空数组）原样保留。找不到这个包返回 false
 */
export function setResource(list: unknown[], source: string, type: string, on: boolean): boolean {
  const i = list.findIndex((e) => sourceOf(e) === source)
  if (i < 0) return false
  const cur = list[i]
  const obj: Record<string, unknown> =
    typeof cur === 'string' ? { source: cur } : { ...(cur as Record<string, unknown>) }
  if (on) {
    if (Array.isArray(obj[type]) && (obj[type] as unknown[]).length === 0) delete obj[type]
  } else obj[type] = []
  list[i] = (Object.keys(obj).length === 1 ? obj.source : obj) as Entry
  return true
}

/** 内置扩展现在开没开：数组里有关掉的写法就是关 */
export function builtinState(arr: unknown, spec: BuiltinExtensions): Record<string, boolean> {
  const list = Array.isArray(arr) ? arr.map(String) : []
  return Object.fromEntries(spec.items.map((x) => [x.id, !list.includes(spec.off.replaceAll('{id}', x.id))]))
}

/** 开关一个内置扩展：返回新数组（关掉加上 off 的写法，打开去掉它；别的项原样） */
export function setBuiltin(arr: unknown, spec: BuiltinExtensions, id: string, on: boolean): unknown[] {
  const off = spec.off.replaceAll('{id}', id)
  const list = (Array.isArray(arr) ? arr : []).filter((x) => x !== off)
  return on ? list : [...list, off]
}
