import { createContext, useContext } from 'react'

/** 父对话的任务页提供：工具条目里点子对话的名字，在右栏打开那个子对话；没有提供时名字不能点 */
export const ChildOpenCtx = createContext<((id: string) => void) | null>(null)
export const useChildOpen = () => useContext(ChildOpenCtx)

/**
 * 父对话的任务页提供：它名下子对话的摘要（任务页自己定时取的那份）。
 * 全局任务列表不含子对话，要知道哪些子对话在干活只能从这里拿；没有提供时是空的
 */
export const ChildListCtx = createContext<{ id: string; title: string; working: boolean; resolved?: boolean }[]>([])
export const useChildList = () => useContext(ChildListCtx)
