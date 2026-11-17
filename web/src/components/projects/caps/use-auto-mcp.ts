import { useCallback } from 'react'
import type { ProjectMcpOverview } from '@shared/projects/mcp'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'

/**
 * 读项目 MCP 时服务端顺带把项目目录里新出现的配置自动导入、在项目里打开了（server/projects/mcp-auto.ts）：
 * 提示一次，并重新取项目列表，让侧栏、能力页的开关和服务端一致（项目设置按版本保存，旧快照会被拒）
 */
export function useAutoMcpNotice() {
  const { setProjects } = useData()
  const refreshProjects = useCallback(() => {
    void api
      .projects()
      .then(setProjects)
      .catch(() => {})
  }, [setProjects])
  const notice = useCallback(
    (o: Pick<ProjectMcpOverview, 'autoEnabled'>) => {
      const names = o.autoEnabled ?? []
      if (!names.length) return
      toast.success(t('已导入并启用项目里的 MCP：{names}', { names: names.join('、') }))
      refreshProjects()
    },
    [refreshProjects],
  )
  return { notice, refreshProjects }
}
