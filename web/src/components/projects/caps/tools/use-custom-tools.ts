import { useCallback, useEffect, useState } from 'react'
import { customToolsContract as C, type ToolList } from '@shared/api-contract/custom-tools'
import type { ToolDraft, ToolScope } from '@shared/custom-tools/schema'
import { t } from '@shared/i18n'
import { call } from '@/lib/api/call'
import { toast, toastError } from '@/lib/toast'

/**
 * 自建工具的列表和增删改（ADR 0082）：「技能与 MCP → 工具」页签和「/」菜单都用。
 * 不轮询：保存、删除、复制后自己重读；Agent 存的工具在下次打开页面或点刷新时出现
 */
export function useCustomTools(projectId: string | undefined) {
  const [data, setData] = useState<ToolList>()
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    call(C.list, { query: projectId ? { projectId } : {} })
      .then((r) => {
        setData(r)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
  }, [projectId])
  useEffect(reload, [reload])

  const save = async (scope: ToolScope, tool: ToolDraft, replace: boolean, note = '') => {
    const r = await call(C.save, {
      body: { projectId, scope, tool: tool as ToolDraft & { id: string; name: string }, replace, note, by: '' },
    })
    reload()
    return r
  }
  const remove = (scope: ToolScope, id: string) =>
    call(C.remove, { params: { scope, id }, query: projectId ? { projectId } : {} })
      .then((r) => {
        toast.success(r.info || t('已删除'))
        reload()
      })
      .catch(toastError)
  const copy = (scope: ToolScope, id: string, to: ToolScope, move: boolean) =>
    call(C.copy, { params: { scope, id }, body: { projectId, to, move } })
      .then(() => {
        toast.success(move ? t('已移动') : t('已复制'))
        reload()
      })
      .catch(toastError)
  const run = (body: {
    scope?: ToolScope
    id?: string
    draft?: ToolDraft
    args: Record<string, unknown>
    dryRun: boolean
  }) =>
    call(C.run, {
      body: { projectId, ...body, draft: body.draft as (ToolDraft & { id: string }) | undefined },
    })
  return { data, error, reload, save, remove, copy, run }
}
export type CustomTools = ReturnType<typeof useCustomTools>
