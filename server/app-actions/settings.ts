import { z } from 'zod'
import type { Settings } from '../../shared/schema.ts'
import { ActionError, defineAction } from './registry.ts'

/** 全局设置这一组 */

/**
 * AI 能读能改的设置：白名单。只放外观、超时、上限这类改错了也只影响体验的字段。
 * 不放的：密钥（apis、clis 的环境变量、webSearch.key、imageGen）、访问控制（remoteAccess、requireToken）、
 * 面板会执行的路径（blender.path、shell）、请求发去哪里（proxy、webhook、webSearch.endpoint、modelCatalog）。
 * 用黑名单时新加的密钥字段默认就漏给了 AI（webSearch.key、blender.path 都这样漏过），所以新字段默认不可见
 */
export const VISIBLE_SETTINGS = [
  'stepTimeoutMinutes',
  'idleTimeoutMinutes',
  'childIdleAskMinutes',
  'presenceGraceMinutes',
  'unreadGraceMinutes',
  'reclaimIdleCli',
  'keepAliveLimit',
  'autoArchiveDays',
  'backgroundLimit',
  'largeFileMB',
  'memorySampleSeconds',
  'longPasteChars',
  'defaultCli',
  'cliOrder',
  'openBrowser',
  'contentWidth',
  'appearance',
  'userName',
  'askUserDefault',
  'developerMode',
  'elementPicker',
  'fileFormat',
  'language',
  'usagePricingModel',
] as const satisfies readonly (keyof Settings)[]
const visible = new Set<string>(VISIBLE_SETTINGS)

export const visibleSettings = (s: Settings) => Object.fromEntries(Object.entries(s).filter(([k]) => visible.has(k)))

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
    description:
      '读面板的全局设置里 AI 可以看的那部分（外观、超时、上限等；密钥、访问控制、网络地址、可执行路径不给）。改之前先读，确认字段名和现在的值。',
    level: 'read',
    input: z.object({}),
    run: async (_a, ctx) => visibleSettings((await ctx.api('GET', '/settings')) as Settings),
  }),
  defineAction({
    name: 'settings.set',
    title: '改全局设置',
    description:
      '改全局设置的若干项：patch 只写要改的字段（对象会逐层合并，数组整个替换），字段名用 settings.get 读到的。保存后开着的设置窗口会刷新。只能改 settings.get 读得到的字段；密钥、访问控制、网络地址、可执行路径不能改。',
    level: 'write',
    input: z.object({ patch: z.record(z.string(), z.unknown()).describe('要改的字段，例如 {"backgroundLimit": 32}') }),
    run: async (a, ctx) => {
      const cur = (await ctx.api('GET', '/settings')) as Settings
      const unknown = Object.keys(a.patch).filter((k) => !(k in cur))
      if (unknown.length) throw new ActionError(`没有这些设置：${unknown.join('、')}`)
      const bad = Object.keys(a.patch).filter((k) => !visible.has(k))
      if (bad.length) throw new ActionError(`这些设置不能由 AI 改：${bad.join('、')}，请用户自己在设置里改`)
      const saved = (await ctx.api('PUT', '/settings', mergePatch(cur, a.patch))) as Settings
      // 开着的设置窗口拿新值重建，免得它的自动保存把旧值写回去；没有页面开着也不算失败
      ctx.ui('reload_settings', {})
      return Object.fromEntries(Object.keys(a.patch).map((k) => [k, (saved as Record<string, unknown>)[k]]))
    },
  }),
]
