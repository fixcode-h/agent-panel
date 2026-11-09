import { useEffect, useSyncExternalStore } from 'react'
import type { ProjectExperience } from '@shared/experience'
import { experienceApi } from './api-experience'

/**
 * 按项目缓存的经验列表：对话里每张「学到经验」卡片都要看这几条现在的状态（停用了、删了、改过了），
 * 同一个项目只拉一次；卡片和项目设置的「经验」页改动后用 setProjectExperience 写回，所有卡片跟着变
 */
interface Entry {
  items?: ProjectExperience[]
  error?: string
  loading?: boolean
}
const cache = new Map<string, Entry>()
const subs = new Set<() => void>()
let version = 0
const emit = () => {
  version++
  for (const f of subs) f()
}

function load(projectId: string) {
  const cur = cache.get(projectId)
  if (cur?.items || cur?.loading) return
  cache.set(projectId, { loading: true })
  experienceApi
    .list(projectId)
    .then((v) => cache.set(projectId, { items: v.items }))
    .catch((e: Error) => cache.set(projectId, { error: e.message }))
    .finally(emit)
}

export function setProjectExperience(projectId: string, items: ProjectExperience[]) {
  cache.set(projectId, { items })
  emit()
}

/** 这个项目现在的经验：还没拉到时 items 是 undefined（卡片先按消息里的快照画） */
export function useProjectExperience(projectId: string | undefined): Entry {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => version,
  )
  useEffect(() => {
    if (projectId) load(projectId)
  }, [projectId])
  return (projectId && cache.get(projectId)) || {}
}
