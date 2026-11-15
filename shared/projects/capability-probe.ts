import { z } from 'zod'

/**
 * 项目「能力」页的插件探查（插件接口 9，设计稿：Agent侧栏与项目管理重设计 6.3）：
 * 列出按项目生效（清单 activation = project）的插件，问开着的插件 detect（按目录推荐）和 ready（还缺什么设置）。
 * 正式后端（server/projects/capabilities.ts）和演示后端都用这里的 probeRow 拼行，形状只有一份。
 */
export const CapabilityProbeInput = z.object({
  /** 已有项目的 id；新建项目时为空 */
  projectId: z.string().default(''),
  /** 项目目录（新建项目时是表单里填的，还没保存） */
  path: z.string().default(''),
  /** 表单里的插件设置草稿（project.plugins）：ready 按没保存的设置判断，改完不用先保存才消黄点 */
  plugins: z.record(z.string(), z.unknown()).default({}),
})
export type CapabilityProbeInput = z.infer<typeof CapabilityProbeInput>

export const CapabilityPluginRow = z.object({
  id: z.string(),
  name: z.string(),
  /** 清单里的图标名（pluginIcon 认的） */
  icon: z.string(),
  description: z.string(),
  /** 插件页的全局开关：关着时插件没在运行，项目里打开也不生效 */
  enabled: z.boolean(),
  /** detect 给的推荐理由；不推荐时为空 */
  reason: z.string(),
  /** ready 给的「还缺什么」；已经能用时为空 */
  missing: z.string(),
  /** detect / ready 出错的原文（照实显示，不悄悄当成不推荐） */
  error: z.string(),
})
export type CapabilityPluginRow = z.infer<typeof CapabilityPluginRow>

export const CapabilityProbe = z.object({ plugins: z.array(CapabilityPluginRow) })
export type CapabilityProbe = z.infer<typeof CapabilityProbe>

/** 拼一行：清单字段 + 探查结果，缺的补空字符串（界面按空判断，不按 undefined） */
export function probeRow(
  m: { id: string; name: string; icon?: string; description?: string },
  r: { enabled: boolean; reason?: string; missing?: string; error?: string },
): CapabilityPluginRow {
  return {
    id: m.id,
    name: m.name,
    icon: m.icon ?? '',
    description: m.description ?? '',
    enabled: r.enabled,
    reason: r.reason?.trim() ?? '',
    missing: r.missing?.trim() ?? '',
    error: r.error ?? '',
  }
}

/** 新建项目时默认打开哪些：只打开有推荐理由、并且全局开着的（用户定：不默认全开） */
export const recommendedPlugins = (rows: CapabilityPluginRow[]) =>
  rows.filter((r) => r.enabled && r.reason && !r.error).map((r) => r.id)
