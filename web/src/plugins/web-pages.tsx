import { AppWindow, Globe, PenTool } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PluginManifest } from '@shared/plugins/types'
import type { PluginWebPage } from '@shared/plugins/runtime-schema'
import { WebFrame } from '@/components/ui/web-frame'
import { pluginIcon } from './icon'
import { webPageTarget } from './web-page-target'
import type { PluginPage } from './sdk'

/**
 * 插件接口 11 的 webPages：清单里声明的网页页面，插件不写网页代码，面板用网页框（WebFrame）画成插件整页。
 * 和插件网页入口登记的页面走同一套（图标栏 / 项目工具、#/plugin/<插件>/<页面>），scope 不写时跟着插件的 activation。
 * 托管进程的页面打开时没起就起（服务端 serviceOrigin），网页框开着时会定时报「有人在用」，空闲计时不会到
 */

/** 网页页面常用、角色图标里没有的几个 */
const PAGE_ICONS: Record<string, typeof Globe> = { globe: Globe, 'pen-tool': PenTool, 'app-window': AppWindow }

function pageOf(m: Pick<PluginManifest, 'id' | 'activation'>, w: PluginWebPage): PluginPage {
  const target = webPageTarget(m.id, w.url)
  const Icon = PAGE_ICONS[w.icon] ?? pluginIcon(w.icon)
  return {
    id: w.id,
    label: t(w.label),
    scope: w.scope ?? (m.activation === 'project' ? 'project' : 'global'),
    icon: (p) => <Icon {...p} />,
    // 网页应用切走再切回来不重新加载：画板、编辑器里没存的东西都还在
    keep: true,
    Page: ({ project }) => (
      <div className="flex h-full min-h-0 flex-col bg-bg">
        <WebFrame target={target} projectId={project} title={t(w.label)} className="min-h-0 flex-1" />
      </div>
    ),
  }
}

/** 一个插件清单里声明的网页页面 */
export const declaredWebPages = (m: Pick<PluginManifest, 'id' | 'activation' | 'webPages'>): PluginPage[] =>
  (m.webPages ?? []).map((w) => pageOf(m, w))
