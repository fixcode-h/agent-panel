import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeStateView } from '@shared/knowledge/candidate'
import { knowledgeApi } from '@/lib/api-experience'

/**
 * 候选、没配上的查询、对教训的建议：打开页面时拉一次，操作后调 reload 再拉（不轮询）。
 * 没保存过的项目（没有 id）、请求失败都当成「没有」，页面照常显示空态
 */
export function useKnowledgeState(projectId?: string) {
  const [state, setState] = useState<KnowledgeStateView>()
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setState(await knowledgeApi.state(projectId))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [projectId])
  useEffect(() => void reload(), [reload])
  return { state, error, reload }
}
