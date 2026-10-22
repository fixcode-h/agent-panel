import { createContext, useContext } from 'react'

/** 父对话的任务页提供：工具条目里点子对话的名字，在右栏打开那个子对话；没有提供时名字不能点 */
export const ChildOpenCtx = createContext<((id: string) => void) | null>(null)
export const useChildOpen = () => useContext(ChildOpenCtx)
