import { useEffect, useState } from 'react'
import { resolveParams } from '@shared/agents/role'
import { DOC_PLACE_SIBLING, resolveDocRoot, type DocGroupView } from '@shared/doc-root'
import { t } from '@shared/i18n'
import type { Agent, ParamValues } from '@shared/schema'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * 「文档」角色下面的文档根提示：P4 / SVN 项目按现在选的下拉算出会写到哪。
 * 文档放在项目外（默认）时，同一工程的各分支共用一个文档根（ADR 0052）：从服务端取共用的位置、分支和待合并的冲突，
 * 可以改到别处；还没保存的新项目、演示版取不到时按下拉算出的位置显示
 */
export function DocRootHint({
  projectId,
  path,
  vcs,
  agent,
  values,
}: {
  projectId: string
  path: string
  vcs: string
  agent: Agent
  values: ParamValues
}) {
  const d = resolveDocRoot(path, vcs, resolveParams(agent.params, values).values)
  const shared = !!d && d.place === DOC_PLACE_SIBLING && !!projectId
  const [group, setGroup] = useState<DocGroupView | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!shared) return setGroup(null)
    let alive = true
    api
      .docGroup(projectId)
      .then((g) => alive && setGroup(g))
      // 取不到（项目目录读不到、演示版）就按下拉算出的位置显示，不打扰用户
      .catch(() => alive && setGroup(null))
    return () => {
      alive = false
    }
  }, [shared, projectId, path])
  if (!d) return null
  if (!group)
    return (
      <p className="mt-2 text-xs text-subtle">
        {t('这个项目的文档根：{dir}', { dir: d.root })}
        {d.outside ? t('（在项目外，写进去的文档不做 P4 / SVN 操作）') : t('（在项目里，随项目纳入版本管理）')}
      </p>
    )
  const save = async () => {
    if (editing === null) return
    setSaving(true)
    try {
      setGroup(await api.setDocGroupRoot(projectId, editing))
      setEditing(null)
      toast.success(t('已改共用文档根，原来的文档已合并过去'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const others = group.branches.filter((b) => b.name !== group.branch).map((b) => b.name)
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs text-subtle">
      <p>
        {t('各分支共用的文档根：{dir}', { dir: group.root })}
        {t('（在项目外，写进去的文档不做 P4 / SVN 操作）')}
        {editing === null && (
          <Button variant="link" className="ml-1 text-xs" onClick={() => setEditing(group.root)}>
            {t('修改')}
          </Button>
        )}
      </p>
      <p>
        {t('当前分支：{name}', { name: group.branch })}
        {others.length > 0 && t('；共用的其他分支：{list}', { list: others.join(t('、')) })}
        {t('。分支按项目文件夹区分：同名项目文件夹、分支目录在同一上级下的项目共用文档。')}
      </p>
      {group.conflicts.length > 0 && (
        <p className="text-warning">
          {t('合并各分支的旧文档时有 {n} 个文件内容不同，已另存成 .from-<分支>，项目对话会派「文档」合并。', {
            n: group.conflicts.length,
          })}
        </p>
      )}
      {group.errors.map((e) => (
        <p key={e} className="text-danger">
          {t('合并旧文档出错：{error}', { error: e })}
        </p>
      ))}
      {editing !== null && (
        <div className="mt-1 flex items-center gap-2">
          <Input
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            placeholder={t('文档根的完整路径')}
            className="flex-1"
          />
          <Button size="sm" onClick={save} disabled={saving || !editing.trim()}>
            {t('保存')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
            {t('取消')}
          </Button>
        </div>
      )}
    </div>
  )
}
