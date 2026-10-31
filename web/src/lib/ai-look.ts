import { createContext, useContext } from 'react'

/**
 * AI 分析窗口里嵌的分析对话：过程默认展开、追问气泡和输入框更紧凑。
 * 思考和工具行不在这里另画，和普通对话用同一套样子（用户 2026-10-31 要求）。只由 TaskView 在 embed + 分析对话时打开，
 * 普通对话页、右栏子对话都拿到默认的 false，样子不变
 */
export const AiLookCtx = createContext(false)
export const useAiLook = () => useContext(AiLookCtx)
