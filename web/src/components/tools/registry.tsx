import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { Download, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'

/** 「小工具」页里的一个工具：列表里一行，右边整块是它自己的界面 */
export interface ToolDef {
  /** 地址里用的 id（#/tools/<id>），发布后不改，收藏的链接要能打开 */
  id: string
  label: () => string
  desc: () => string
  icon: LucideIcon
  /** 按需加载：工具多了也不拖慢首屏 */
  Component: LazyExoticComponent<ComponentType>
}

/**
 * 小工具注册表：加一个工具就在这里加一项（界面放 web/src/components/tools/<工具>.tsx，
 * 服务端接口放 server/tools/<工具>.ts，契约写进 shared/api-contract/tools.ts），页面和导航不用改
 */
export const TOOLS: ToolDef[] = [
  {
    id: 'gh-download',
    label: () => t('GitHub 加速下载'),
    desc: () => t('贴一个 GitHub 地址，经代理或镜像加速下载到本机'),
    icon: Download,
    Component: lazy(() => import('./GhDownloadTool').then((m) => ({ default: m.GhDownloadTool }))),
  },
]
