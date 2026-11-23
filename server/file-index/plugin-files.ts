/**
 * 给插件的文件索引（插件接口 16，PluginServerContext.files）：在 ProjectIndex 外面包一层，进出一律绝对路径。
 * 插件拿到 undefined（项目没开索引、找不到项目）时退回自己原来的走法
 */
import path from 'node:path'
import type { PluginFileIndex, PluginFiles } from '../plugins/sdk.ts'
import { projectIndex, projectOfDir, touchFiles } from './registry.ts'

const slash = (p: string) => p.split(path.sep).join('/')

export function pluginFilesApi(pluginId: string): PluginFiles {
  return {
    index: async (projectIdOrDir) => {
      const id = path.isAbsolute(projectIdOrDir) ? await projectOfDir(projectIdOrDir) : projectIdOrDir
      if (!id) return undefined
      const idx = await projectIndex(id)
      if (!idx) return undefined
      const view: PluginFileIndex = {
        projectPath: idx.projectPath,
        // 只等项目自己的根：引擎目录还在建时项目里的文件已经能查（引擎目录的 list 在下面单独判断）
        ready: (ms) => idx.ready(ms, true),
        find: (q, o = {}) =>
          idx.find(q, { under: o.under, ext: o.ext, dirs: o.dirs, cap: o.limit ?? 5000 }).map((h) => slash(h.abs)),
        list: async (dir, o) => {
          // 那份索引还没建完：给 undefined，插件照旧自己走目录，别拿半份当全的
          if (idx.partialAt(dir)) return undefined
          return idx.list(dir, { ...o, abs: true })
        },
        glob: (dir, patterns) => idx.glob(dir, patterns).map(slash),
        has: (abs) => (idx.partialAt(abs) ? undefined : idx.has(abs)),
        onChange: (dirs, cb) =>
          idx.onChange(
            dirs.map((d) => path.resolve(d)),
            (d) => cb({ added: d.added.map(slash), removed: d.removed.map(slash) }),
          ),
        refresh: async (dir) => {
          await idx.refresh(dir)
        },
      }
      return view
    },
    touch: (absPaths) => void touchFiles(absPaths, `plugin:${pluginId}`),
  }
}
