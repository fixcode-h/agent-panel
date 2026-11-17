import { useEffect, useMemo, useRef, useState } from 'react'
import { projectsContract as P } from '@shared/api-contract/projects'
import type { CapabilityPluginRow } from '@shared/projects/capability-probe'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { call } from '@/lib/api/call'
import { usePlugins } from '@/plugins/registry'
import type { ProjectCapabilities } from '@shared/projects/capabilities'
import { globalItems, itemOn, ownItems, pluginMcpItems, type CapItem } from './caps-items'
import { useAutoMcpNotice } from './use-auto-mcp'
import { useMcpCatalog } from '@/components/settings/mcp/mcp-store'

/**
 * 按项目生效的插件探查（detect / ready）：目录、表单里的插件设置变了再问一遍（停顿一下再问，打字时不连发）。
 * 出错照实返回，界面显示原文
 */
export function useCapabilityProbe(projectId: string, path: string, plugins: Record<string, unknown> | undefined) {
  const [rows, setRows] = useState<CapabilityPluginRow[] | null>(null)
  const [error, setError] = useState('')
  const pluginsKey = JSON.stringify(plugins ?? {})
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    const timer = setTimeout(() => {
      call(P.capabilityProbe, { body: { projectId, path, plugins: plugins ?? {} } })
        .then((r) => {
          if (n !== seq.current) return
          setRows(r.plugins)
          setError('')
        })
        .catch((e) => n === seq.current && setError((e as Error).message))
    }, 300)
    return () => clearTimeout(timer)
    // plugins 按内容比（pluginsKey），表单每次渲染给的是新对象
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, pluginsKey])
  return { rows, error }
}

/**
 * 项目里能列出的技能和 MCP：项目自己的（目录里的技能、识别到的 MCP 配置）和全局库里的。
 * 没有项目（新建项目还没保存）时只有全局的，项目自己的要保存后才读得到目录
 */
export function useCapsLists(projectId: string | undefined) {
  const { rows: plugins } = usePlugins()
  const [own, setOwn] = useState<CapItem[] | null>(null)
  const [global, setGlobal] = useState<CapItem[] | null>(null)
  // 项目目录里识别到的 MCP 名字（含已经导入的）：「技能与 MCP」页把它们都算项目自己的，全局那块不重复算
  const [detected, setDetected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const { notice } = useAutoMcpNotice()
  useEffect(() => {
    let live = true
    const pluginName = (id: string) => plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id
    const fail = (e: unknown) => live && setError((e as Error).message)
    Promise.all([
      projectId
        ? api.projectMcp(projectId).then((o) => (notice(o), o))
        : api.mcpTools().then((o) => ({ servers: o.servers, detected: [] })),
      projectId ? api.projectSkills(projectId).then((v) => v.skills) : Promise.resolve([]),
      api.bundledSkills().then((r) => r.items),
      api.library('skill').then((r) => r.items),
    ])
      .then(([mcp, skills, bundled, library]) => {
        if (!live) return
        setOwn(ownItems(skills, mcp.detected))
        setDetected(mcp.detected.map((d) => d.name))
        setGlobal(globalItems({ mcp: mcp.servers, bundled, library, pluginName }))
        setError('')
      })
      .catch(fail)
    return () => {
      live = false
    }
    // 插件列表只用来取插件名，变了不用重读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tick])
  return { own, global, detected, error, reload: () => setTick((n) => n + 1) }
}

/** 面板自带的 MCP（派子对话、问你、等你操作…）：始终交给 Agent，不进项目清单 */
export const panelMcpItem = (): CapItem => ({
  key: 'mcp:panel',
  kind: 'mcp',
  name: 'agent-panel',
  description: t('派子对话、问你、等你操作、记教训等面板自带的工具'),
  scope: 'always',
  where: t('面板自带'),
  whereNote: '',
})

/**
 * 侧栏「技能与 MCP」一行后面的数字：项目自己的 + 从全局继承的（面板自带的 MCP、在这个项目挂上的插件 MCP、
 * 全局库里在这个项目生效的），和「技能与 MCP」页的「从全局继承」同一个数。读不出来时为 undefined，侧栏就不写数字
 */
export function useProjectCapsCount(project: { id: string; capabilities?: Partial<ProjectCapabilities> }) {
  const { own, global, detected } = useCapsLists(project.id)
  const { rows } = usePlugins()
  if (!own || !global) return undefined
  const plugins = pluginMcpItems(rows, project).length
  const names = new Set(detected)
  const inherited = global.filter((x) => itemOn(x, project.capabilities) && !(x.kind === 'mcp' && names.has(x.name)))
  return { own: own.filter((x) => x.kind === 'skill').length + names.size, inherited: 1 + plugins + inherited.length }
}

/**
 * 插件 MCP 挂在哪些对话：取设置 →「MCP」同一份能力目录（各插件 catalog() 的 attach），
 * 「技能与 MCP」页据此把只在某个页面里挂的插件（UI 设计、Blender）写成「按场景」而不是「全局」
 */
export function usePluginAttach(): (id: string) => string {
  const { data } = useMcpCatalog()
  return useMemo(() => {
    const m = new Map<string, string>()
    for (const s of data?.sources ?? [])
      if (s.kind === 'plugin')
        m.set(
          s.id.replace(/^plugin:/, ''),
          s.servers
            .map((x) => x.attach)
            .filter(Boolean)
            .join(t('；')),
        )
    return (id: string) => m.get(id) ?? ''
  }, [data])
}
