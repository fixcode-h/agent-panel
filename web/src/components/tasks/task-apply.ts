import { createContext, useContext } from 'react'
import type { Task } from '@shared/schema'

/**
 * 对话页把接口返回的整份对话应用到页面上（view/use-task-load.ts 的 apply）：深处的小按钮（撤销放行规则这类）改了对话后
 * 直接用返回值刷新，不等推送（演示版没有推送，正式版推送晚到也不闪）。不在对话页里时没有，调用方只当没这回事
 */
export const TaskApplyCtx = createContext<((t: Task) => void) | null>(null)

export const useTaskApply = () => useContext(TaskApplyCtx)
