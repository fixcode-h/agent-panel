import type { ComponentType, ReactNode } from 'react'
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

/**
 * 插件自己的整页（插件接口 2）：宽屏在图标栏通用功能下面另起一组，手机在抽屉菜单里；地址 #/plugin/<插件>/<页面>/<path>。
 * path 是插件自己的子位置（一段字符串，插件自己编码），用 host.hooks.usePluginRoute 读写
 */
export interface PluginPage {
  id: string
  label: string
  /** 函数组件（lucide 图标或自己画的 svg）：图标栏按 24px、线宽 1.75 画 */
  icon: (p: { className?: string; strokeWidth?: number }) => ReactNode
  /** 图标右上角的小点（有新内容、出错），给文字时也写进悬停提示 */
  useDot?: () => string | boolean | undefined
  /**
   * 这一页管的对话（task.plugin 等于它的对话，例如 Blender 插件的 blender.model）：Agent 项目和 Chat 的列表不列这些对话，
   * 从通知、旧链接打开时转到这一页（#/plugin/<插件>/<页面>/<对话 id>）。插件关掉后对话照常列在原处
   */
  taskPlugin?: string
  Page: ComponentType<{ path: string }>
}

/**
 * 插件能看的一类文件（2026-11-10 加的，旧面板没有这一项时照旧交给系统默认程序）：对话里的文件标记、文件浏览页点到这些
 * 扩展名的文件时，面板弹出和文件预览同一个外壳的弹窗（标题栏是路径），内容交给 Viewer 画。
 * 面板自己读不了的二进制格式（.uasset 这类）由懂它的插件来读。
 */
export interface FileViewer {
  id: string
  /** 认领的扩展名：小写、不带点（uasset） */
  exts: string[]
  /** 弹窗标题栏的图标，不给用文件图标 */
  icon?: ComponentType<{ className?: string }>
  Viewer: ComponentType<FileViewerProps>
}

export interface FileViewerProps {
  /** 本机上的完整路径 */
  path: string
  /** 文件所在的面板项目；聊天对话、项目外的附件没有 */
  projectId?: string
  /** 从哪个对话点开的；文件浏览页没有 */
  taskId?: string
  /** 关掉弹窗（查看器里跳去别的页面之前调） */
  close: () => void
}

export interface WebPlugin {
  designModes?: DesignMode[]
  pages?: PluginPage[]
  taskTabs?: TaskTab[]
  fileViewers?: FileViewer[]
  /** 插件页上参数表单下面的运行状态面板：status 是服务端 ServerPlugin.status 的结果 */
  Status?: ComponentType<{ status: Record<string, unknown> | undefined; config: PluginConfig; reload: () => void }>
}

export type WebHost = ReturnType<typeof host>
export type ActivateWeb = (host: WebHost) => WebPlugin | Promise<WebPlugin>
