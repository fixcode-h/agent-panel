import { createContext, useContext } from 'react'

/**
 * AI 分析窗口里嵌的分析对话：左侧对话区照设计稿 AiWindow 画（思考一行带摘要、过程行不铺底色、
 * 过程默认展开、追问气泡和输入框更紧凑）。只由 TaskView 在 embed + 分析对话时打开，
 * 普通对话页、右栏子对话都拿到默认的 false，样子不变
 */
export const AiLookCtx = createContext(false)
export const useAiLook = () => useContext(AiLookCtx)
