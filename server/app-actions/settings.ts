import { z } from 'zod'
import type { Settings } from '../../shared/schema.ts'
import { ActionError, defineAction } from './registry.ts'

/** 全局设置这一组 */

/** 密钥和访问控制：API 的 key、CLI 的环境变量和账号、外网隧道的 token、访问令牌开关。不读不写 */
export const HIDDEN_SETTINGS = ['apis', 'clis', 'remoteAccess', 'requireToken'] as const
const hidden = new Set<string>(HIDDEN_SETTINGS)

export const visibleSettings = (s: Settings) => Object.fromEntries(Object.entries(s).filter(([k]) => !hidden.has(k)))

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 对象逐层合并，数组和值整个替换：改 appearance.theme 不会把 appearance 的其他项清掉 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = mergePatch(base[k], v)
  return out
}

export const settingsActions = [
  defineAction({
    name: 'settings.get',
    title: '读全局设置',
    description: `读面板的全局设置（${HIDDEN_SETTINGS.join('、')} 这些密钥和访问控制不给）。改之前先读，确认字段名和现在的值。`,
    level: 'read',
    input: z.object({}),
    run: async (_a, ctx) => visibleSettings((await ctx.api('GET', '/settings')) as Settings),
  }),
  defineAction({
    name: 'settings.set',
    title: '改全局设置',
    description:
      '改全局设置的若干项：patch 只写要改的字段（对象会逐层合并，数组整个替换），字段名用 settings.get 读到的。保存后开着的设置窗口会刷新。密钥和访问控制不能改。',
    level: 'write',
    input: z.object({ patch: z.record(z.string(), z.unknown()).describe('要改的字段，例如 {"backgroundLimit": 32}') }),
    run: async (a, ctx) => {
      const bad = Object.keys(a.patch).filter((k) => hidden.has(k))
      if (bad.length) throw new ActionError(`这些设置不能由 AI 改：${bad.join('、')}，请用户自己在设置里改`)
      const cur = (await ctx.api('GET', '/settings')) as Settings
      const unknown = Object.keys(a.patch).filter((k) => !(k in cur))
      if (unknown.length) throw new ActionError(`没有这些设置：${unknown.join('、')}`)
      const saved = (await ctx.api('PUT', '/settings', mergePatch(cur, a.patch))) as Settings
      // 开着的设置窗口拿新值重建，免得它的自动保存把旧值写回去；没有页面开着也不算失败
      ctx.ui('reload_settings', {})
      return Object.fromEntries(Object.keys(a.patch).map((k) => [k, (saved as Record<string, unknown>)[k]]))
    },
  }),
]
