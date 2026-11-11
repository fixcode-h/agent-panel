import { useEffect, useState, useSyncExternalStore } from 'react'
import type { TableSchema } from '@shared/tables'
import { tablesApi } from './tables-api'

/**
 * 表格结构文件（表头、枚举、校验……）在页面里只留一份，按项目记。
 * 以前项目设置的「表头」「通用枚举」「校验」「AI 分析」和表格页各读各的：AI 分析写进去后，
 * 「表头」还显示旧的，再点它的保存就把 AI 写的盖掉了。现在谁保存都更新这一份，所有地方跟着变
 */
const cache = new Map<string, TableSchema>()
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** 直接换成这一份（已经保存过的，或者先显示、随后保存的） */
export function putTableSchema(projectId: string, s: TableSchema) {
  cache.set(projectId, s)
  emit()
}

/**
 * 改一部分再保存：先重新读结构文件，在最新的上面改，不盖掉别处（别的窗口、别人）刚存的；
 * 存好后所有用到它的地方一起更新
 */
export async function saveTableSchema(projectId: string, update: (cur: TableSchema) => TableSchema) {
  const cur = await tablesApi.schema(projectId)
  const saved = await tablesApi.saveSchema(projectId, update(cur))
  putTableSchema(projectId, saved)
  return saved
}

/** 读结构文件：打开时总是重读一次（文件可能被版本控制更新过），读到前先用手上的那份 */
export function useTableSchema(projectId: string) {
  const schema = useSyncExternalStore(subscribe, () => cache.get(projectId) ?? null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setError('')
    tablesApi
      .schema(projectId)
      .then((s) => live && putTableSchema(projectId, s))
      .catch((e) => live && setError((e as Error).message))
    return () => {
      live = false
    }
  }, [projectId])
  return { schema, error }
}

/**
 * 设置表单的草稿跟着结构文件走：别处保存了（AI 分析写进去、另一块设置存了），
 * 这里又没改过时换成新的；这里改了一半就留着，免得把用户正在改的冲掉
 */
export function useSchemaDraft<T>(schema: TableSchema | null, pick: (s: TableSchema) => T) {
  const [st, setSt] = useState<{ base: TableSchema | null; saved: T | null; draft: T | null }>({
    base: null,
    saved: null,
    draft: null,
  })
  let cur = st
  if (schema && schema !== st.base) {
    const saved = pick(schema)
    const dirty = st.saved !== null && JSON.stringify(st.saved) !== JSON.stringify(st.draft)
    cur = { base: schema, saved, draft: dirty ? st.draft : saved }
    // 渲染中按新的结构文件对齐草稿（React 允许组件在渲染时更新自己的状态）
    setSt(cur)
  }
  return {
    saved: cur.saved,
    draft: cur.draft,
    changed: JSON.stringify(cur.saved) !== JSON.stringify(cur.draft),
    setDraft: (f: (d: T) => T) => setSt((s) => (s.draft === null ? s : { ...s, draft: f(s.draft) })),
    /** 自己刚保存完：草稿换成存进去的样子（输入框里的写法可能和存进去的不完全一样） */
    reset: (saved: TableSchema) => setSt({ base: saved, saved: pick(saved), draft: pick(saved) }),
  }
}
