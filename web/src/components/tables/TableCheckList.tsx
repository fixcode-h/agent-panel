import { useEffect, useState } from 'react'
import { CircleCheck, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableHit } from '@shared/tables'
import { cellRef } from '@shared/table-edit'
import { tablesApi, type TablesCheck } from '@/lib/tables-api'
import { GroupHeader, ListGroup } from '@/components/layout/ListPane'
import { Button } from '@/components/ui/button'

/**
 * 表格页左侧的「检查」：整个项目的表格按结构文件查一遍（类型、枚举、引用、范围、主键重复），
 * 按文件 · 工作表分组列出来；点一行打开那个文件、滚到那一格。query 按文件名和字段名筛
 */
export function TableCheckList({
  projectId,
  query,
  seq,
  onOpen,
}: {
  projectId: string
  query: string
  /** 结构文件或表格保存后加一：重新查 */
  seq: number
  onOpen: (h: TableHit) => void
}) {
  const [result, setResult] = useState<TablesCheck | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    tablesApi
      .check(projectId)
      .then((r) => live && setResult(r))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [projectId, seq, again])

  if (error) return <p className="px-3 py-4 text-footnote text-danger">{error}</p>
  if (!result)
    return (
      <div className="flex justify-center p-6 text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  const q = query.trim().toLowerCase()
  const groups = result.sheets.filter(
    (g) => !q || g.path.toLowerCase().includes(q) || g.first.some((p) => p.field.toLowerCase().includes(q)),
  )
  const total = result.sheets.reduce((n, g) => n + g.count, 0)
  return (
    <div className="flex flex-col gap-1" aria-busy={loading}>
      <div className="flex items-center gap-2 px-2 pt-1 text-caption text-subtle">
        <span className="min-w-0 flex-1">
          {total
            ? t('{files} 个表格查完，{n} 处不合规', { files: result.files, n: total })
            : t('{files} 个表格查完，没有发现问题', { files: result.files })}
        </span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => setAgain((n) => n + 1)}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {t('重新检查')}
        </Button>
      </div>
      {total === 0 && result.failed.length === 0 && (
        <p className="flex items-center justify-center gap-2 px-3 py-6 text-footnote text-subtle">
          <CircleCheck className="h-4 w-4 text-success" />
          {t('按列的类型、枚举、引用、取值范围和主键查过了')}
        </p>
      )}
      {total > 0 && q && groups.length === 0 && (
        <p className="px-3 py-6 text-center text-footnote text-subtle">
          {t('没有和「{q}」有关的问题', { q: query.trim() })}
        </p>
      )}
      {groups.map((g) => (
        <ListGroup
          key={`${g.path}#${g.sheet}`}
          label={`${g.path} · ${g.sheet}`}
          header={
            <GroupHeader
              compact
              label={
                <span className="flex min-w-0 items-center gap-1.5" title={`${g.path} · ${g.sheet}`}>
                  <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{g.path.slice(g.path.lastIndexOf('/') + 1)}</span>
                </span>
              }
              count={g.count}
            />
          }
        >
          {g.first.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOpen({ path: g.path, sheet: g.sheet, row: p.r, col: p.c, text: p.msg })}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--c-row-radius) px-2 text-left text-body hover:bg-sel/60"
            >
              <span className="w-12 shrink-0 font-mono text-caption text-subtle">{cellRef(p.r, p.c)}</span>
              <span className="min-w-0 flex-1 truncate text-footnote">
                <span className="font-mono text-muted">{p.field}</span>
                <span className="ml-2 text-danger">{p.msg}</span>
              </span>
            </button>
          ))}
          {g.count > g.first.length && (
            <p className="px-2 py-1 text-caption text-subtle">
              {t('还有 {n} 处，打开文件后点「检查」看全部', { n: g.count - g.first.length })}
            </p>
          )}
        </ListGroup>
      ))}
      {result.failed.map((f) => (
        <p key={f.path} className="px-2 py-1 text-caption text-danger" title={f.error}>
          {t('{path} 打不开：{error}', { path: f.path, error: f.error })}
        </p>
      ))}
    </div>
  )
}
