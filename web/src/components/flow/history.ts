import { useReducer } from 'react'
import type { Flow } from '@shared/schema'

/**
 * 流程图编辑器的撤销 / 重做历史。
 *
 * 只存在内存里、每个工作流各一份（按工作流 id），切到别的工作流再回来还能接着撤销；刷新页面就没了。
 * 记的是整份 flows 的快照：节点增删、连线、移动、属性修改都改 flows，撤销时整份换回去，
 * 交给外面的草稿照常自动保存，不需要另外的「撤销」接口。
 */
const LIMIT = 100
/** 属性栏里连续输入时，相隔不到这么久的改动合成一步，不然每个字都要撤销一次 */
const TYPE_GAP = 1000

type History = { past: Flow[][]; future: Flow[][]; key: string; at: number }
const store = new Map<string, History>()

function get(id: string): History {
  let h = store.get(id)
  if (!h) store.set(id, (h = { past: [], future: [], key: '', at: 0 }))
  return h
}

export function useFlowHistory(id: string) {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const h = get(id)
  return {
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    /**
     * 改动之前调用，传改动前的 flows。key 相同的连续改动合成一步：
     * 拖动（move:开头）一次拖动从按下到松手都是同一个 key；其他 key 相隔不到 TYPE_GAP 才合并
     */
    record(prev: Flow[], key = '') {
      const now = Date.now()
      const merge = !!key && key === h.key && (key.startsWith('move:') || now - h.at < TYPE_GAP)
      h.key = key
      h.at = now
      if (merge) return
      h.past.push(prev)
      if (h.past.length > LIMIT) h.past.shift()
      h.future = []
      bump()
    },
    /** 撤销：返回要换回去的 flows，没有可撤销的返回 undefined */
    undo(cur: Flow[]) {
      const prev = h.past.pop()
      if (!prev) return undefined
      h.future.push(cur)
      h.key = ''
      bump()
      return prev
    },
    redo(cur: Flow[]) {
      const next = h.future.pop()
      if (!next) return undefined
      h.past.push(cur)
      h.key = ''
      bump()
      return next
    },
  }
}
