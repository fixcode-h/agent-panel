/**
 * 设置「工具路由」页上每个能力的几条路和现在的状态。查找（find）取能力路由现成的来源：插件登记的外部路（UEToVS、IDEA 的 lua_code……）
 * 按这个项目能用的服务看能不能用（server/capability-router/find/external.ts 的 ready），最后是面板按文本找的兜底（要项目开着文件索引）。
 * 其余能力这一期还没接上真的路：校验列出项目能用的自建工具，读资源、改动生效标「第几期接上」
 */
import { t } from '../../shared/i18n.ts'
import { CAPABILITIES } from '../../shared/capability-router/capabilities.ts'
import type { CapabilityId } from '../../shared/capability-router/types.ts'
import type { CapabilityView } from '../../shared/api-contract/tool-gateway.ts'
import { usable } from '../../shared/custom-tools/text.ts'
import { pluginFindSources } from '../plugins/find-sources.ts'
import { routeServers } from '../capability-router/servers.ts'
import { externalSource } from '../capability-router/find/external.ts'
import { statusOf } from '../file-index/registry.ts'
import { listTools } from '../custom-tools/store.ts'

type Routes = CapabilityView['routes']

async function findRoutes(project: { id: string; path: string }): Promise<Routes> {
  const [specs, servers] = await Promise.all([pluginFindSources(project), routeServers([project.path])])
  const ctx = { projectId: project.id, dirs: [project.path] }
  const out: Routes = []
  for (const spec of [...specs].sort((a, b) => a.rank - b.rank)) {
    const r = await externalSource(spec, servers, ctx).ready({} as never)
    out.push({
      id: spec.id,
      label: `${spec.id} · ${spec.langs.join(' / ')}`,
      state: r.state,
      ...(r.state !== 'ready' ? { why: r.why } : {}),
    })
  }
  const idx = await statusOf(project.id).catch(() => undefined)
  out.push({
    id: 'panel.text',
    label: t('面板按文本找（兜底）'),
    state: idx?.enabled ? (idx.state === 'building' || idx.state === 'verifying' ? 'starting' : 'ready') : 'down',
    ...(idx?.enabled ? {} : { why: t('项目没开文件索引') }),
  })
  return out
}

async function verifyRoutes(projectId: string): Promise<Routes> {
  const { entries } = await listTools(projectId || undefined).catch(() => ({ entries: [] }))
  return usable(entries).map((e) => ({
    id: `custom_tool:${e.tool!.id}`,
    label: t('自建工具 · {name}', { name: e.tool!.name }),
    state: 'ready' as const,
  }))
}

/** 没有项目时查找只说「选一个项目看」 */
export async function routesOf(
  project: { id: string; path: string } | undefined,
): Promise<(id: CapabilityId) => Routes> {
  const find = project
    ? await findRoutes(project).catch((e: Error) => [{ id: 'error', label: e.message, state: 'down' as const }])
    : []
  const verify = await verifyRoutes(project?.id ?? '')
  // 已经能问到状态的几条路；其余标「第几期接上」
  const known: Partial<Record<CapabilityId, Routes>> = { find, ...(verify.length ? { verify } : {}) }
  return (id) =>
    known[id] ?? [
      {
        id: `${id}:planned`,
        label: t('第 {n} 期接上', { n: String(CAPABILITIES.find((c) => c.id === id)?.phase ?? '') }),
        state: 'planned',
      },
    ]
}
