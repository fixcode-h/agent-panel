/**
 * 对话正文搜索（命令面板和侧栏共用一份结果）：输入停下来才请求，边输边搜也不会每按一个键就扫一遍对话文件。
 * 上一次的结果先留着，新结果回来再换：列表不会在打字时闪成空。
 */
import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '@shared/task-search'
import { api } from './api'

/** 防抖：停下来这么久才发请求 */
export const SEARCH_DEBOUNCE_MS = 250
/** 少于这么多字不搜正文：一个字能命中一大片，扫一遍对话文件不值得 */
export const SEARCH_MIN_CHARS = 2

export function useTaskSearch(query: string) {
  const q = query.trim()
  const enabled = q.length >= SEARCH_MIN_CHARS
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  // 只认最后一次请求的结果：先发的慢请求不能把后发的快请求盖掉
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled) {
      seq.current++
      setHits([])
      setLoading(false)
      return
    }
    setLoading(true)
    const mine = ++seq.current
    const timer = setTimeout(() => {
      api
        .searchTasks(q)
        .then((res) => {
          if (mine === seq.current) setHits(res.hits)
        })
        // 搜索失败不在打字时弹错误：保留上一次的结果，只是不再转加载
        .catch(() => {})
        .finally(() => {
          if (mine === seq.current) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q, enabled])
  return { hits, loading, enabled }
}
