/**
 * 插件登记的查找路（插件接口 21 的 findSources，例如 UE 插件登记 UEToVS、IDEA 的 lua_code）：
 * 只问在这个项目里打开了的插件；插件出错或超时就当没有，查找照样走面板自带的文本兜底
 */
import type { ExternalFindSource } from '../../shared/capability-router/find/types.ts'
import type { Project } from '../../shared/schema.ts'
import { log } from '../log.ts'
import { pluginGate } from './project-gate.ts'
import { runningPlugins } from './runtime.ts'

const ASK_MS = 3_000

export async function pluginFindSources(p: Pick<Project, 'id' | 'path'>): Promise<ExternalFindSource[]> {
  const out: ExternalFindSource[] = []
  for (const { id, plugin } of runningPlugins()) {
    if (!plugin.findSources || !(await pluginGate(id, p.id)).on) continue
    const list = await Promise.race([
      Promise.resolve(plugin.findSources({ id: p.id, path: p.path })),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), ASK_MS).unref?.()),
    ]).catch((e) => {
      log.warn('find', `插件 ${id} 登记查找路出错`, e)
      return undefined
    })
    for (const s of list ?? [])
      if (s?.id && s.tool && typeof s.args === 'function') out.push({ ...s, id: `${id}:${s.id}` })
  }
  return out
}
