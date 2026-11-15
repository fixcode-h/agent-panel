import path from 'node:path'
import { DATA_FILES, readJson, writeJsonAtomic } from '../store.ts'
import type { Migration } from './index.ts'

/**
 * 项目能力（插件接口 9）：插件可以改成「按项目生效」，只在项目 capabilities.plugins 里打开了的项目挂工具。
 * 旧项目里已经给插件配置过东西的（project.plugins[<插件 id>]，例如表格目录），视为这个项目在用它，
 * 一次性记进 capabilities.plugins，插件升级成按项目生效后照旧能用。
 * 不靠 project.plugins 存设置的插件（例如 UE 自己记接入了哪些项目）由插件升级时用 PluginServerContext.projects.enable 自己补。
 * 重复跑不会重复添加；已经有 capabilities 的项目只补缺的
 */
export const projectCapabilities: Migration = {
  version: 6,
  name: 'project-capabilities',
  async run(ctx) {
    const file = path.join(ctx.dataDir, DATA_FILES['projects.json'])
    const list = (await readJson(file).catch(() => undefined)) as Record<string, unknown>[] | undefined
    if (!Array.isArray(list)) return
    const used = (p: Record<string, unknown>) =>
      p && typeof p === 'object' && p.plugins && typeof p.plugins === 'object'
        ? Object.keys(p.plugins as Record<string, unknown>)
        : []
    const caps = (p: Record<string, unknown>) =>
      (p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {}) as Record<string, unknown>
    const missing = (p: Record<string, unknown>) => {
      const have = caps(p).plugins
      const on = Array.isArray(have) ? have : []
      return used(p).filter((id) => !on.includes(id))
    }
    if (!list.some((p) => missing(p).length)) return
    await ctx.backup(file)
    let n = 0
    for (const p of list) {
      const add = missing(p)
      if (!add.length) continue
      const c = caps(p)
      const on = Array.isArray(c.plugins) ? (c.plugins as string[]) : []
      p.capabilities = { ...c, plugins: [...on, ...add] }
      n++
    }
    await writeJsonAtomic(file, list)
    ctx.log(`给 ${n} 个项目打开了已经配置过的插件能力`)
  },
}
