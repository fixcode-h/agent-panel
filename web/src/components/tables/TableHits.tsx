import { useMemo } from 'react'
import { FileSpreadsheet, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableHit, TableSearch } from '@shared/tables'
import { colName } from '@/lib/sheet'
import { GroupHeader, ListGroup } from '@/components/layout/ListPane'

/**
 * 表格页左侧的内容搜索结果：按文件分组，每处命中一行（工作表!格子 + 那格的字，命中的词高亮）。
 * 点一行打开那个文件、切到那张表、滚到那一格
 */
export function TableHits({
  result,
  query,
  loading,
  error,
  onOpen,
}: {
  result: TableSearch | null
  query: string
  loading: boolean
  error?: string
  onOpen: (h: TableHit) => void
}) {
  const groups = useMemo(() => {
    const m = new Map<string, TableHit[]>()
    for (const h of result?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h])
    return [...m]
  }, [result])
  if (error) return <p className="px-3 py-4 text-footnote text-danger">{error}</p>
  if (!query.trim())
    return <p className="px-3 py-6 text-center text-footnote text-subtle">{t('输入要找的字，在所有表格的格子里找')}</p>
  if (loading && !result)
    return (
      <div className="flex justify-center p-6 text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  if (!groups.length)
    return (
      <p className="px-3 py-6 text-center text-footnote text-subtle">
        {t('{n} 个表格里都没有「{q}」', { n: result?.files ?? 0, q: query })}
      </p>
    )
  return (
    <div className="flex flex-col gap-1" aria-busy={loading}>
      <p className="px-2 pt-1 text-caption text-subtle">
        {t('{files} 个文件里找到 {n} 处', { files: groups.length, n: result!.hits.length })}
        {result?.truncated && t('（只列出前 {n} 处）', { n: result.hits.length })}
      </p>
      {groups.map(([path, hits]) => (
        <ListGroup
          key={path}
          label={path}
          header={<GroupHeader compact label={<HitFile path={path} />} count={hits.length} />}
        >
          {hits.slice(0, 50).map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOpen(h)}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-(--c-row-radius) px-2 text-left text-body hover:bg-sel/60"
            >
              <span className="w-16 shrink-0 truncate font-mono text-caption text-subtle" title={h.sheet}>
                {colName(h.col)}
                {h.row + 1}
              </span>
              <Mark text={h.text} q={query} />
            </button>
          ))}
          {hits.length > 50 && (
            <p className="px-2 py-1 text-caption text-subtle">
              {t('还有 {n} 处，打开文件后用表格里的查找', { n: hits.length - 50 })}
            </p>
          )}
        </ListGroup>
      ))}
    </div>
  )
}

function HitFile({ path }: { path: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={path}>
      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{path.slice(path.lastIndexOf('/') + 1)}</span>
    </span>
  )
}

/** 命中的词加底色 */
function Mark({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase())
  if (i < 0) return <span className="min-w-0 flex-1 truncate text-muted">{text}</span>
  const n = q.trim().length
  // 命中在很后面时从前面截掉一段，让命中的词露出来
  const from = Math.max(0, i - 16)
  return (
    <span className="min-w-0 flex-1 truncate text-muted">
      {from > 0 && '…'}
      {text.slice(from, i)}
      <mark className="rounded-[3px] bg-accent/20 px-px text-fg">{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </span>
  )
}
