import { useState } from 'react'
import type { ColLayout } from '@/components/files/SheetTable'

const EMPTY: ColLayout = { freeze: 0, hidden: [] }

/** 表格页一个文件（工作表）的列布局：冻结前几列、隐藏的列，记在本机（localStorage），表格文件不动 */
export function useColLayout(key: string) {
  const store = `sheet-cols:${key}`
  const read = (): ColLayout => {
    try {
      const v = JSON.parse(localStorage.getItem(store) ?? 'null') as Partial<ColLayout> | null
      return { freeze: Math.max(0, Number(v?.freeze) || 0), hidden: Array.isArray(v?.hidden) ? v.hidden : [] }
    } catch {
      return EMPTY
    }
  }
  const [state, setState] = useState(() => ({ key: store, l: read() }))
  const layout = state.key === store ? state.l : read()
  const set = (l: ColLayout) => {
    const next = { freeze: l.freeze, hidden: [...new Set(l.hidden)].sort((a, b) => a - b) }
    setState({ key: store, l: next })
    try {
      localStorage.setItem(store, JSON.stringify(next))
    } catch {
      // 存不了（隐私模式）就只在这次打开里有效
    }
  }
  return [layout, set] as const
}
