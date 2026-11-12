import { z } from 'zod'

/**
 * CLI 自己配置文件里的设置项（ADR 0050）：没有命令行参数、也没有单次覆盖办法的设置（例如 Pi settings.json 的重试、
 * 超时、压缩），设置页直接读写 CLI 的配置文件。只写用户改过的键，「恢复默认」删掉这个键，别的键原样保留；
 * 终端里的 CLI 也会跟着变，界面上写明。这里只放定义和纯函数，读写文件在 server/cli/config-settings.ts
 */
export const ConfigSetting = z
  .object({
    id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    label: z.string(),
    hint: z.string().default(''),
    /** 配置文件（~、${ENV:-默认值} 照常展开），JSON */
    file: z.string(),
    /** 点分路径，例如 retry.maxRetries */
    at: z.string().regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/),
    type: z.enum(['boolean', 'number', 'choice']),
    /** CLI 自己的默认值：没写过时显示「跟随（默认值）」 */
    default: z.union([z.boolean(), z.number(), z.string()]),
    min: z.number().optional(),
    max: z.number().optional(),
    /** 数字的单位（界面文案，例如「秒」）；scale 是界面上的数乘多少写进文件（秒 → 毫秒写 1000） */
    unit: z.string().default(''),
    scale: z.number().positive().default(1),
    choices: z.array(z.object({ id: z.string().min(1), label: z.string() })).default([]),
  })
  .refine(
    (s) =>
      s.type === 'choice'
        ? s.choices.some((c) => c.id === s.default)
        : typeof s.default === (s.type === 'boolean' ? 'boolean' : 'number'),
    { message: 'default 要和 type 对得上：choice 写 choices 里的一个 id' },
  )
export type ConfigSetting = z.infer<typeof ConfigSetting>
export type ConfigValue = boolean | number | string

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 按点分路径取值，路径上有一段不是对象就是没写过 */
export function getAt(data: unknown, at: string): unknown {
  let cur: unknown = data
  for (const k of at.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * 按点分路径写值（原地改）；value 为 undefined 时删掉这个键，删空的上级对象也一并删掉。
 * 路径上有一段已经是别的类型（例如用户写成了数字）时不覆盖，返回 false
 */
export function setAt(data: Record<string, unknown>, at: string, value: unknown): boolean {
  const parts = at.split('.')
  const chain: Record<string, unknown>[] = [data]
  for (const k of parts.slice(0, -1)) {
    const cur = chain[chain.length - 1]
    if (cur[k] === undefined) {
      if (value === undefined) return true
      cur[k] = {}
    }
    if (!isObj(cur[k])) return false
    chain.push(cur[k] as Record<string, unknown>)
  }
  const last = parts[parts.length - 1]
  if (value !== undefined) {
    chain[chain.length - 1][last] = value
    return true
  }
  delete chain[chain.length - 1][last]
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break
    delete chain[i - 1][parts[i - 1]]
  }
  return true
}

/** 文件里的值换成界面上的值：类型对不上（手写错了）当没写过 */
export function readValue(s: ConfigSetting, raw: unknown): ConfigValue | undefined {
  if (s.type === 'boolean') return typeof raw === 'boolean' ? raw : undefined
  if (s.type === 'number') return typeof raw === 'number' && Number.isFinite(raw) ? raw / s.scale : undefined
  return typeof raw === 'string' && s.choices.some((c) => c.id === raw) ? raw : undefined
}

/** 界面上的值换成要写进文件的值；不合法时返回错误原因（界面文案的 key 由调用方翻译） */
export function writeValue(s: ConfigSetting, v: unknown): { value: unknown } | { error: string } {
  if (s.type === 'boolean') return typeof v === 'boolean' ? { value: v } : { error: 'type' }
  if (s.type === 'choice')
    return typeof v === 'string' && s.choices.some((c) => c.id === v) ? { value: v } : { error: 'choice' }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'type' }
  if ((s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max)) return { error: 'range' }
  return { value: Math.round(v * s.scale) }
}

/** 界面上显示的 CLI 默认值 */
export function defaultLabel(s: ConfigSetting, on: string, off: string): string {
  if (s.type === 'boolean') return s.default ? on : off
  if (s.type === 'choice') return s.choices.find((c) => c.id === s.default)?.label ?? String(s.default)
  return `${s.default}${s.unit ? ` ${s.unit}` : ''}`
}
