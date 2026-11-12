import path from 'node:path'
import { DATA_FILES, readJson, writeJsonAtomic } from '../store.ts'
import type { Migration } from './index.ts'

/**
 * 表格功能搬成插件（重构文档第 15 条）：项目上的表格设置从 project.tables 挪到 project.plugins.tables
 * （插件按项目存设置的地方，WebPlugin.projectSections）。没装表格插件的也挪：设置原样留着，装上插件就接着用。
 * 已经在 plugins.tables 里有设置的（重复跑）不覆盖，只去掉旧键；结构文件和数据目录 tables/ 不动，插件照旧读那里
 */
export const projectTables: Migration = {
  version: 5,
  name: 'project-tables',
  async run(ctx) {
    const file = path.join(ctx.dataDir, DATA_FILES['projects.json'])
    const list = (await readJson(file).catch(() => undefined)) as Record<string, unknown>[] | undefined
    if (!Array.isArray(list)) return
    const has = (p: Record<string, unknown>) => p && typeof p === 'object' && 'tables' in p
    if (!list.some(has)) return
    await ctx.backup(file)
    let n = 0
    for (const p of list) {
      if (!has(p)) continue
      const plugins = (p.plugins && typeof p.plugins === 'object' ? p.plugins : {}) as Record<string, unknown>
      if (p.tables !== undefined && plugins.tables === undefined) {
        p.plugins = { ...plugins, tables: p.tables }
        n++
      }
      delete p.tables // delete-ok: 原始 JSON 对象，不是经 store.update 合并的数据
    }
    await writeJsonAtomic(file, list)
    if (n) ctx.log(`把 ${n} 个项目的表格设置挪进了 plugins.tables`)
  },
}
