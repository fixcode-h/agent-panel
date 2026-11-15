import type { Route } from '@/lib/data'
import { usePluginPages } from './registry'

/**
 * 当前地址是不是盖住会话侧栏的项目工具页（PluginPage.cover，例如 UE、表格）：
 * 是的话宽屏不显示会话侧栏，插件自己的导航栏占那个位置，导航栏顶上的项目卡片点一下回到项目对话
 */
export function useCoversSidebar(route: Route) {
  const pages = usePluginPages()
  return (
    route.page === 'plugin' &&
    !!route.project &&
    pages.some((p) => p.cover && p.scope === 'project' && p.plugin === route.id && p.id === route.sub)
  )
}
