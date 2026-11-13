import { useEffect, useSyncExternalStore } from 'react'
import { mcpCatalogContract as C } from '@shared/api-contract/mcp-catalog'
import type { McpCatalog } from '@shared/mcp-catalog/types'
import { call } from '@/lib/api/call'

/**
 * 设置 →「MCP」的能力目录：二级列表（个数、缺说明的点）和各页共用一份，打开设置后第一次用到时读，
 * 「刷新」按钮重读（插件开关、升级后）。目录只在设置里看，不跟着推送实时变
 */
interface State {
  data?: McpCatalog
  error?: string
  loading: boolean
}
let state: State = { loading: false }
let asked = false
const subs = new Set<() => void>()
const set = (s: State) => {
  state = s
  subs.forEach((f) => f())
}

export function reloadMcpCatalog() {
  asked = true
  set({ ...state, loading: true, error: undefined })
  call(C.catalog)
    .then((data) => set({ data, loading: false }))
    .catch((e) => set({ ...state, loading: false, error: (e as Error).message }))
}

export function useMcpCatalog() {
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )
  useEffect(() => {
    if (!asked) reloadMcpCatalog()
  }, [])
  return s
}
