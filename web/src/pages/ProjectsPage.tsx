import { useEffect } from 'react'
import { useData, useNav, useTasks } from '@/lib/data'
import { ownedPage, ownedPageRoute, usePluginPages } from '@/plugins/registry'
import { ProjectWorkspace } from '@/components/tasks/ProjectWorkspace'
import { AllProjects } from '@/components/projects/AllProjects'
import { ProjectCapsPage } from '@/components/projects/caps/ProjectCapsPage'

/**
 * 项目页：#/projects 是「全部项目」卡片页（侧栏项目下拉底部进来），#/projects/<id> 是项目工作区；
 * 项目设置是弹窗，分类在「设置 · 项目分类」里管理。指定的项目已删除时回到首页。
 */
export function ProjectsPage() {
  const { loading, projects } = useData()
  const { tasks } = useTasks()
  const { route, go, openProject } = useNav()
  const selected = projects.find((p) => p.id === route.id)
  const subTask = route.sub ? tasks.find((x) => x.id === route.sub) : undefined
  const pages = usePluginPages()
  const page = subTask ? ownedPage(subTask, pages) : undefined

  useEffect(() => {
    if (loading || !route.id) return
    if (!selected) go({ page: 'home' })
    // 插件整页管的对话（模型设计的旧对话还挂在项目下）：转到插件页里打开
    else if (page && subTask) go(ownedPageRoute(page, subTask.id))
    // 旧链接 #/projects/<id>/settings：改成打开设置弹窗
    else if (route.sub === 'settings') {
      go({ page: 'projects', id: selected.id })
      openProject(selected.id)
    }
    // 导航函数每次渲染都是新的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, selected, route.id, route.sub, tasks, page])

  if (!route.id) return <AllProjects />
  if (!selected || route.sub === 'settings') return null
  if (page) return null
  // 项目工具里的「技能与 MCP」（#/projects/<id>/capabilities）：普通整页，套上和别的页面一样的面板底
  if (route.sub === 'capabilities')
    return (
      <div className="panel flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden">
        <ProjectCapsPage key={selected.id} project={selected} />
      </div>
    )
  return <ProjectWorkspace key={selected.id} project={selected} sub={route.sub} />
}
