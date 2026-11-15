import { useEffect, useRef, useState } from 'react'
import type { Project, ProjectInput } from '@shared/schema'
import { recommendedPlugins } from '@shared/projects/capability-probe'
import { ProjectCapabilities } from '@shared/projects/capabilities'
import type { SetDraft } from '../settings/project-draft'
import { useCapabilityProbe } from './use-caps-data'

/**
 * 项目设置弹窗里「能力」的探查和新建项目的推荐（设计稿 6.3）：
 * - 按目录和草稿里的插件设置问 detect / ready，左栏的黄点、能力页都用这一份；
 * - 新建项目时，目录定下来、探查回来后按推荐理由打开插件，其余都关着（用户定：不默认全开）。
 *   换了目录就按新目录重新推荐；用户自己动过开关之后就不再替他改
 */
export function useCapsDraft({
  project,
  draft,
  setDraft,
}: {
  project?: Project
  draft: ProjectInput
  setDraft: SetDraft
}) {
  const probe = useCapabilityProbe(project?.id ?? '', draft.path.trim(), draft.plugins)
  const [recommended, setRecommended] = useState<string[]>([])
  const applied = useRef<{ path: string; plugins: string } | null>(null)
  useEffect(() => {
    if (project || !probe.rows || !draft.path.trim()) return
    const mine = (draft.capabilities?.plugins ?? []).join()
    // 上次替他填的值被改过了：是用户自己开关的，不再覆盖
    if (applied.current && applied.current.plugins !== mine) return
    if (applied.current?.path === draft.path.trim()) return
    const rec = recommendedPlugins(probe.rows)
    applied.current = { path: draft.path.trim(), plugins: rec.join() }
    setRecommended(rec)
    setDraft((d) => ({
      ...d,
      capabilities: { ...ProjectCapabilities.parse(d.capabilities ?? {}), plugins: rec },
    }))
    // 只在探查结果回来时判断；草稿别的字段变了不用重算
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [probe.rows])
  return { probe, recommended }
}

/** 左栏「能力」后面的数字：这个项目打开了几个按项目生效的能力 */
export const capsCount = (caps: Partial<ProjectCapabilities> | undefined) =>
  (caps?.plugins?.length ?? 0) + (caps?.mcp?.length ?? 0) + (caps?.skills?.length ?? 0)
