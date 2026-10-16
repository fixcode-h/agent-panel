import { useEffect } from 'react'
import { useData, useNav } from '@/lib/data'
import { ProjectWorkspace } from '@/components/tasks/ProjectWorkspace'

/**
 * 项目页只剩项目工作区：项目列在侧栏里，项目设置是弹窗，分类在「设置 · 项目分类」里管理。
 * 没有指定项目（或项目已删除）时回到首页。
 */
export function ProjectsPage() {
  const { loading, projects } = useData()
  const { route, go, openProject } = useNav()
  const selected = projects.find((p) => p.id === route.id)

  useEffect(() => {
    if (loading) return
    if (!selected) go({ page: 'home' })
    // 旧链接 #/projects/<id>/settings：改成打开设置弹窗
    else if (route.sub === 'settings') {
      go({ page: 'projects', id: selected.id })
      openProject(selected.id)
    }
    // 导航函数每次渲染都是新的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected, route.sub])

  if (!selected || route.sub === 'settings') return null
  return <ProjectWorkspace key={selected.id} project={selected} sub={route.sub} />
}
