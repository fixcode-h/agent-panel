/**
 * 插件报来的项目外目录（插件接口 16 的 fileIndexRoots，例如 UE 插件报引擎目录）：
 * 只问在这个项目里打开了的插件；插件出错或超时就当没有，不挡索引
 */
import type { Project } from '../../shared/schema.ts'
import type { PluginRoot } from '../file-index/registry.ts'
import { log } from '../log.ts'
import { pluginGate } from './project-gate.ts'
import { runningPlugins } from './runtime.ts'

const ASK_MS = 5_000

export async function pluginIndexRoots(p: Project): Promise<PluginRoot[]> {
  const out: PluginRoot[] = []
  for (const { id, plugin } of runningPlugins()) {
    if (!plugin.fileIndexRoots || !(await pluginGate(id, p.id)).on) continue
    const roots = await Promise.race([
      plugin.fileIndexRoots({ id: p.id, path: p.path }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), ASK_MS).unref?.()),
    ]).catch((e) => {
      log.warn('file-index', `插件 ${id} 报外部目录出错`, e)
      return undefined
    })
    for (const r of roots ?? [])
      if (r?.root) out.push({ root: r.root, plugin: id, ...(r.exclude ? { exclude: r.exclude } : {}) })
  }
  return out
}
