import type { ReactNode } from 'react'
import { useData, useNav } from '@/lib/data'
import { projectReturnRoute } from '@/lib/projects/return-route'
import { ArrowLeft } from 'lucide-react'
import { ProjectBackButton } from '@/components/ui/project-switcher'
import { RailAction } from '@/components/ui/section-rail'
import { t } from '@shared/i18n'

/**
 * 盖住侧栏的项目工具页（PluginPage.cover）导航栏顶上的项目卡片，交给插件用（host.ui.ProjectBackCard）：
 * 点一下回到这个项目最近看的对话。名字、小字不给时用面板项目的名字和目录
 */
export function ProjectBackCard({
  projectId,
  name,
  meta,
  icon,
  className,
}: {
  projectId: string
  name?: ReactNode
  meta?: ReactNode
  icon?: (p: { className?: string; strokeWidth?: number }) => ReactNode
  className?: string
}) {
  const { go } = useNav()
  const project = useData().projects.find((p) => p.id === projectId)
  return (
    <ProjectBackButton
      name={name ?? project?.name ?? projectId}
      meta={meta ?? project?.path}
      icon={icon}
      className={className}
      onClick={() => go(projectReturnRoute(projectId))}
    />
  )
}

/**
 * 图标轨顶上的「回到项目」（host.ui.ProjectBackRail，UE 页用）：和 ProjectBackCard 一样回到这个项目最近看的对话，
 * 只是画成图标轨的一个按钮，省掉二级面板顶上那张项目卡（用户 2026-11-18 定）
 */
export function ProjectBackRail({ projectId, name }: { projectId: string; name?: string }) {
  const { go } = useNav()
  const project = useData().projects.find((p) => p.id === projectId)
  return (
    <RailAction
      icon={ArrowLeft}
      short={t('返回')}
      label={t('回到项目 · {name}', { name: name ?? project?.name ?? projectId })}
      onClick={() => go(projectReturnRoute(projectId))}
    />
  )
}
