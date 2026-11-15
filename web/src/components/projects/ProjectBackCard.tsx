import type { ReactNode } from 'react'
import { useData, useNav } from '@/lib/data'
import { projectReturnRoute } from '@/lib/projects/return-route'
import { ProjectBackButton } from '@/components/ui/project-switcher'

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
