import type { ComponentType } from 'react'
import type { PluginConfig } from '@shared/plugins/types'
import type { Task } from '@shared/schema'
import type { host } from './host'

/**
 * 插件网页 SDK（ADR 0059）：插件包里 web 入口的约定。插件仓库（fixcode-h/agent-plugins）里有一份类型副本，
 * 改了这里要同步过去，不兼容的改动把 PLUGIN_API 加一。
 *
 * 入口是一个 ESM 文件，默认导出 activate(host)，返回 WebPlugin。React 用面板的那一份：插件构建时把 react、
 * react/jsx-runtime、react-dom 换成 globalThis.__agentPanel 上的（见插件仓库的构建脚本），自己的其他依赖打包进去。
 * 插件里的 Tailwind 类名用面板的主题变量（bg-panel、text-muted…），样式表由插件自己构建、放在包里的 css。
 */

/** 设计模式下多出来的一类设计（侧栏顶上的下拉里一项）：对话按 task.plugin = id 归它，打开时进 #/pdesign/<id>/<对话> */
export interface DesignMode {
  id: string
  name: string
  desc: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** 图标底色（主题里的状态色类名，例如 bg-peer） */
  tone?: string
  /** 侧栏空列表的说明和新建按钮的文字 */
  empty: string
  newLabel: string
  /** 新建这类设计的弹窗：建好后调 onCreated(对话) 打开它 */
  NewDialog: ComponentType<{ open: boolean; onOpenChange: (o: boolean) => void; onCreated: (task: Task) => void }>
}

/** 对话右栏多一个页签 */
export interface TaskTab {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  /** 哪些对话有这个页签 */
  when: (task: Task) => boolean
  /** 有这个页签的对话右栏默认停在它上面、默认展开右栏 */
  home?: boolean
  Panel: ComponentType<{ task: Task }>
}

export interface WebPlugin {
  designModes?: DesignMode[]
  taskTabs?: TaskTab[]
  /** 插件页上参数表单下面的运行状态面板：status 是服务端 ServerPlugin.status 的结果 */
  Status?: ComponentType<{ status: Record<string, unknown> | undefined; config: PluginConfig; reload: () => void }>
}

export type WebHost = ReturnType<typeof host>
export type ActivateWeb = (host: WebHost) => WebPlugin | Promise<WebPlugin>
