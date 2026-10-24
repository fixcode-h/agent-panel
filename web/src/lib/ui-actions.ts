import { useEffect, useRef } from 'react'

/**
 * 对话里的 Agent 要页面做的界面操作（切页面、打开设置、打开项目设置……）：
 * 服务端的动作表（server/app-actions）经 /api/app/events 推一条 ui 事件，这里按名字找处理函数执行。
 * 加一个界面操作 = 服务端加一个动作 + 这里的处理表（App.tsx 的 UiActions）加一项，见 docs/adr/0011
 */

export type UiHandler = (args: Record<string, unknown>) => void

let table: { current: Record<string, UiHandler> } | null = null

/** 收到一条 ui 事件；没登记的名字忽略（旧页面收到新版本服务的动作） */
export function runUiAction(action: string, args: Record<string, unknown>) {
  const h = table?.current[action]
  if (!h) return false
  h(args ?? {})
  return true
}

/** 登记处理表：每次渲染都换成最新的闭包，事件来了用的是当前的导航和数据 */
export function useUiActions(list: Record<string, UiHandler>) {
  const ref = useRef(list)
  ref.current = list
  useEffect(() => {
    table = ref
    return () => {
      if (table === ref) table = null
    }
  }, [])
}

/** 设置被 AI 改了：开着的设置窗口用新值重建，免得自动保存把旧值写回去 */
const settingsListeners = new Set<() => void>()
export function onSettingsReloaded(fn: () => void) {
  settingsListeners.add(fn)
  return () => {
    settingsListeners.delete(fn)
  }
}
export const settingsReloaded = () => settingsListeners.forEach((fn) => fn())

export const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
