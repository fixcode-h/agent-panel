import { createContext, useContext } from 'react'
import type { ToolUse } from '@shared/schema'

/**
 * 面板里的跳转，由父对话的任务页提供：
 * - child：工具条目里点子对话的名字，在右栏打开那个子对话；
 * - run：子对话（右栏面板或单独打开）里点「启动工作流」这一行，就地换成那次运行的视图（带返回和输入框）。
 * 没有提供时（子对话自己不显示子对话、父对话点运行仍是弹窗口）对应的名字不能点。
 * 放在同一个上下文里：任务页的标题栏外面只套一层，不用为了多一个入口再套一层
 */
export interface PaneNav {
  child?: (id: string) => void
  run?: (tool: ToolUse) => void
}

export const PaneNavCtx = createContext<PaneNav | null>(null)

export const useChildOpen = () => useContext(PaneNavCtx)?.child ?? null
export const useRunOpen = () => useContext(PaneNavCtx)?.run ?? null

/**
 * 父对话的任务页提供：它名下子对话的摘要（任务页自己定时取的那份）。
 * 全局任务列表不含子对话，要知道哪些子对话在干活只能从这里拿；没有提供时是空的
 */
export const ChildListCtx = createContext<
  {
    id: string
    title: string
    working: boolean
    resolved?: boolean
    /** 本次开启的时间（最近一轮开始执行），行右边的时长从这里算（见 childStartedAt） */
    startedAt?: string
    /** 最后一次有变化的时间：等用户时用它停住计时 */
    updatedAt?: string
    /** 待用户确认的请求数、没回答的提问数：有就是停在那里等你 */
    requests?: number
    asking?: number
  }[]
>([])
export const useChildList = () => useContext(ChildListCtx)
