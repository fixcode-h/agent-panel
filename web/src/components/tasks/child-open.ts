import { createContext, useContext } from 'react'
import type { ToolUse } from '@shared/schema'
import type { ChildSummary } from './child-line'
import type { JobTarget } from './JobDialog'
import type { Letter } from '@/lib/tasks'

/**
 * 面板里的跳转，由父对话的任务页提供：
 * - child：工具条目里点子对话的名字，在右栏打开那个子对话；
 * - runTool：子对话（右栏面板或单独打开）里点「启动工作流」这一行，就地换成那次运行的视图（带返回和输入框）；
 * - runView：运行区里那行「工作流」点了，按运行号打开那次运行的视图。
 * 没有提供时（子对话自己不显示子对话、父对话点运行仍是弹窗口）对应的名字不能点。
 * 放在同一个上下文里：任务页的标题栏外面只套一层，不用为了多一个入口再套一层
 */
export interface PaneNav {
  child?: (id: string) => void
  /** 右栏当前打开的子对话：切换下拉用它标出当前项 */
  openChild?: string
  /** 点「启动工作流」那条工具调用：认回它启动的是第几次运行，打开那次运行的视图 */
  runTool?: (tool: ToolUse) => void
  /**
   * 运行区里那行「工作流」点了：按运行号打开这次运行的视图（父对话开右栏，子对话就地换成那次运行的视图）。
   * 和 runTool 的区别：那个认的是「启动工作流」那条工具调用，这个只要一个运行号（见 web/src/lib/run-row.ts 的 runRow）
   */
  runView?: (run: number) => void
  /** 后台命令行的标题点了：在任务页顶层打开这条命令的窗口（命令跑完那一行会消失，窗口不能跟着没） */
  job?: (job: JobTarget) => void
}

export const PaneNavCtx = createContext<PaneNav | null>(null)

export const useChildOpen = () => useContext(PaneNavCtx)?.child ?? null
export const useRunToolOpen = () => useContext(PaneNavCtx)?.runTool ?? null
export const useRunViewOpen = () => useContext(PaneNavCtx)?.runView ?? null
export const useJobOpen = () => useContext(PaneNavCtx)?.job ?? null

/**
 * 父对话的任务页提供：它名下子对话的摘要（任务页自己定时取的那份）。
 * 全局任务列表不含子对话，要知道哪些子对话在干活只能从这里拿；没有提供时是空的。
 * 给的是完整摘要（ChildSummary）：消息流里的运行区和悬浮层列表显示同一套字段，
 * 以前这里只声明了 working/resolved 几个字段，运行区拿不到计划进度和当前活动。
 */
export const ChildListCtx = createContext<ChildSummary[]>([])
export const useChildList = () => useContext(ChildListCtx)

/**
 * 父对话的任务页提供：它和名下子对话之间的往来信件（见 web/src/lib/tasks.ts 的 childLetters）
 * 和每个子对话还没被父对话读到的汇报数（收件箱）。交代任务那行据此原地写回执，子对话面板据此列每个子对话的信
 */
export interface PeerMail {
  letters: Map<string, Letter[]>
  unread: Map<string, number>
}
export const PeerMailCtx = createContext<PeerMail | null>(null)
export const usePeerMail = () => useContext(PeerMailCtx)
