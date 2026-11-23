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
      const absOf = (p: string) => slash(path.isAbsolute(p) ? p : path.join(idx.projectPath, p))
      const view: PluginFileIndex = {
        projectPath: idx.projectPath,
        ready: (ms) => idx.ready(ms),
        find: (q, o = {}) =>
          idx.find(q, { under: o.under, ext: o.ext, dirs: o.dirs, cap: o.limit ?? 5000 }).map((h) => slash(h.abs)),
        list: async (dir, o) => {
          const r = await idx.list(dir, o)
          return r && { files: r.files.map(absOf), dirs: r.dirs.map(absOf) }
        },
        glob: (dir, patterns) => idx.glob(dir, patterns).map(slash),
        has: (abs) => idx.has(abs),
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
