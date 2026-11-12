import type { ComponentType, ReactNode } from 'react'
import type { PluginConfig } from '@shared/plugins/types'
import type { Attachment, Project, Task } from '@shared/schema'
import type { host } from './host'
import type { SheetHeader } from '@shared/sheet-header'
import type { SheetColHead } from '@/components/files/SheetTable'
import type { SheetHeaderStore } from '@/components/files/use-sheet-view'

/**
 * 插件网页 SDK（ADR 0059）：插件包里 web 入口的约定。插件仓库（fixcode-h/agent-plugins）里有一份类型副本，
 * 改了这里要同步过去，不兼容的改动把 PLUGIN_API 加一。
 *
 * 入口是一个 ESM 文件，默认导出 activate(host)，返回 WebPlugin。React 用面板的那一份：插件构建时把 react、
 * react/jsx-runtime、react-dom 换成 globalThis.__agentPanel 上的（见插件仓库的构建脚本），自己的其他依赖打包进去。
 * 插件里的 Tailwind 类名用面板的主题变量（bg-panel、text-muted…），样式表由插件自己构建、放在包里的 css。
 */

/**
 * 不带面板外壳的独立页（插件接口 4）：地址 #/pbare/<插件>/<页面>/<path>，只挂这个组件，不加载侧栏、数据和导航。
 * 给无头浏览器截图这类场景用（例如 UI 设计让本机 Edge / Chrome 打开设计稿截图）
 */
export interface BarePage {
  id: string
  Page: ComponentType<{ path: string }>
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
 * path 是插件自己的子位置，用 host.hooks.usePluginRoute 读写；插件接口 5 起可以带 /（#/plugin/ui-design/ui/<设计>/<子页>）。
 * 设计类插件（UI 设计、模型设计）都是这样一页：面板没有单独的「设计模式」（插件接口 5 去掉了 designModes）
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
  /** active：这一页现在是不是显示着（keep 的页切走后还挂着，这时为 false，例如快捷键只在显示着时响应） */
  Page: ComponentType<{ path: string; active?: boolean }>
  /**
   * 打开过一次就一直挂着、切走只藏起来（插件接口 6，例如表格页：打开的表、没保存的改动、滚动位置都留着，
   * 切回来不重新加载几千张表的目录）。不给时切走就卸载
   */
  keep?: boolean
  /**
   * 这个位置是不是自己分成几块面板的页面（插件接口 5）：是的话面板不再套一层卡片底，插件自己画列表栏和各块面板
   * （例如 UI 设计左边是自己的项目列表）。不给时整页放在一块卡片里
   */
  split?: (path: string) => boolean
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

/**
 * 插件接管的表格文件（2026-11-12 加的，旧面板没有这一项时不会来问）：文件弹窗打开 xlsx / CSV 时问一遍开着的插件，
 * 认领了的话标题栏多一个按钮（例如表格插件的「在表格页打开」），表头和两行列头按插件给的来
 * （例如项目的表格结构文件），和插件自己的表格页显示得一样；「调整表头」也写回插件那边，不再记在浏览器里。
 * 不认领就照面板原来的：自动识别表头，手动调的记在本机
 */
export interface SheetClaimer {
  /** 认领就返回 SheetClaim；不归自己管返回 undefined。弹窗每打开一个表格文件问一次 */
  claim: (file: SheetFile) => Promise<SheetClaim | undefined>
}

export interface SheetFile {
  /** 本机上的完整路径 */
  path: string
  /** 文件所在的面板项目 */
  projectId: string
  /** 弹窗读文件的根目录：对话的工作目录（独立分支时是 worktree）、文件浏览页是项目目录 */
  root: string
}

export interface SheetClaim {
  /**
   * 标题栏按钮：悬停文字和点了去插件的哪个整页（PluginPage 的 id）、带什么子位置；sheet 是正在看的工作表名，CSV 为空串。
   * 面板先关弹窗再跳过去。不给就没有按钮（例如独立分支里的副本：表格页打开的是项目目录里那一份，不是这个文件）
   */
  open?: { label: string; page: string; path: (sheet: string) => string }
  /** 一张表的表头从哪来：own 这张表自己设的、style 项目统一的；save 是弹窗里「调整表头」后写回 */
  header?: (sheet: string, rows: string[][]) => SheetHeaderStore
  /** 两行列头：每列的字段名 + 类型标签；不给就是普通列头 */
  colHeads?: (sheet: string, rows: string[][], header: SheetHeader) => (SheetColHead | undefined)[]
  /** 表头、列结构在别处变了（保存了表头）时叫一声，弹窗重新取 header / colHeads；返回取消订阅 */
  subscribe?: (onChange: () => void) => () => void
}

/**
 * 插件认领的一类输入框附件（插件接口 6）：拖进、粘贴、选进输入框的文件按扩展名（或 MIME 前缀）归某个插件时，
 * 不拷、不上传，作为卡片只引用原路径；点卡片打开插件的 Dialog，用户在里面选好要发的东西（例如视频插件截的帧图片），
 * 发送时卡片原位换成这些附件。还没选时发送会先打开 Dialog。没挂这个扩展点的输入框照旧当普通文件。
 * Agent 收不了的格式（视频）由懂它的插件转成能收的（图片）
 */
export interface AttachmentIntake {
  id: string
  /** 认领的扩展名：小写、不带点（mp4） */
  exts: string[]
  /** 也按浏览器给的 MIME 前缀认领（video/），没给扩展名的文件靠它 */
  mimes?: string[]
  /** 卡片上的状态：picked 是已经选好的附件数，0 时提示点开去选 */
  status: (picked: number) => string
  /** 还没选就点了发送时的提示（随后打开 Dialog） */
  pending: (name: string) => string
  Dialog: ComponentType<AttachmentIntakeProps>
}

export interface AttachmentIntakeProps {
  /** 要处理的文件：本机绝对路径；chosen 是上次选好的（再打开时照着勾上）。null 表示关着 */
  target: { path: string; name: string; chosen: Attachment[] } | null
  onClose: () => void
  /** 选好的附件交回卡片，发送时换成它们 */
  onInsert: (list: Attachment[]) => void
}

/**
 * 项目设置里的一页（插件接口 6）：导航里多一项，点开画 Section。设置存在项目的 plugins[<插件 id>] 里，
 * 跟项目设置一起保存（用户点「保存」才落盘，关掉不保存就丢掉），内容由插件自己定、自己校验
 */
export interface ProjectSection {
  /** 插件里唯一；地址和导航里用 plugin:<插件 id>:<id> */
  id: string
  label: string
  /** 页面顶上标题（label）下面的一段说明，和面板自己的项目设置页同一个样式 */
  desc?: string
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>
  /** 导航那一项右侧的灰字（例如表格目录）：value 是这个插件在草稿里的设置 */
  hint?: (value: unknown) => string | undefined
  Section: ComponentType<ProjectSectionProps>
}

export interface ProjectSectionProps {
  /** 草稿里这个插件的设置（project.plugins[<插件 id>]），没设过是 undefined */
  value: unknown
  onChange: (next: unknown) => void
  /** 已保存的项目；新建项目时还没有 */
  project?: Project
  /** 项目目录：存在时是解析后的绝对路径，否则是输入框里的原文 */
  base: string
}

/**
 * 设置 →「组件」里的一块示例（插件接口 6）：插件自己的共用组件也要能在设置里看到和微调（用户定的长期规则），
 * 和面板自己的组件示例排在一起
 */
export interface Specimen {
  id: string
  /** 小标题（一般写组件名） */
  label: string
  /** 这块示例用到的可微调部件（设置 →「组件」的部件名，例如 input、menu），点示例时右侧列出它们的调节项 */
  tune?: string[]
  Specimen: ComponentType
}

export interface WebPlugin {
  pages?: PluginPage[]
  taskTabs?: TaskTab[]
  fileViewers?: FileViewer[]
  /** 文件弹窗里的表格文件归不归这个插件（2026-11-12 加的） */
  sheets?: SheetClaimer
  attachmentIntakes?: AttachmentIntake[]
  barePages?: BarePage[]
  projectSections?: ProjectSection[]
  specimens?: Specimen[]
  /** 插件页上参数表单下面的运行状态面板：status 是服务端 ServerPlugin.status 的结果 */
  Status?: ComponentType<{ status: Record<string, unknown> | undefined; config: PluginConfig; reload: () => void }>
}

export type WebHost = ReturnType<typeof host>
export type ActivateWeb = (host: WebHost) => WebPlugin | Promise<WebPlugin>
