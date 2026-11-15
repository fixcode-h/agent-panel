/**
 * 项目「能力」页的插件探查（插件接口 9，契约 shared/api-contract/projects.ts 的 capabilityProbe）：
 * 列出装了的按项目生效插件，问开着的插件 detect（按目录推荐）、ready（还缺什么设置）。
 * 全局关着的插件没在运行，只列出来、不问；出错、超时照原文放进 error，界面照实显示。
 */
import { Hono } from 'hono'
import { installedPlugins, pluginEnabled } from '../../shared/plugins/index.ts'
import { projectsContract as P } from '../../shared/api-contract/projects.ts'
import { probeRow, type CapabilityProbe, type CapabilityProbeInput } from '../../shared/projects/capability-probe.ts'
import { t } from '../../shared/i18n.ts'
import { runningPlugin } from '../plugins/runtime.ts'
import { withPluginLimit } from '../plugins/limit.ts'

export async function probeCapabilities(input: CapabilityProbeInput): Promise<CapabilityProbe> {
  const list = installedPlugins().filter((m) => m.activation === 'project')
  const plugins = await Promise.all(
    list.map(async (m) => {
      const enabled = pluginEnabled(m.id)
      const plugin = enabled ? runningPlugin(m.id) : undefined
      const path = input.path.trim()
      const errors: string[] = []
      const ask = async (fn: (() => unknown) | undefined) => {
        if (!fn) return undefined
        try {
          const v = await withPluginLimit('probe', fn)
          return typeof v === 'string' ? v : undefined
        } catch (e) {
          errors.push((e as Error).message)
          return undefined
        }
      }
      // 没有目录时不问 detect：插件按空路径读目录只会报错或给出误导的推荐
      const reason = await ask(path && plugin?.detect ? () => plugin.detect!({ path }) : undefined)
      const missing = await ask(
        plugin?.ready ? () => plugin.ready!({ id: input.projectId, path, plugins: input.plugins }) : undefined,
      )
      return probeRow(m, { enabled, reason, missing, error: errors.join('；') })
    }),
  )
  return { plugins }
}

export function projectCapabilitiesApi() {
  return new Hono().post('/probe', async (c) => {
    const body = P.capabilityProbe.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('探查项目能力的参数不对') }, 400)
    return c.json(await probeCapabilities(body.data))
  })
}
