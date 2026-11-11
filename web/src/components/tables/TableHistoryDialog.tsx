import { useEffect, useMemo, useState } from 'react'
import { History, Loader2, Undo2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SheetData } from '@shared/files'
import type { TableSchema } from '@shared/tables'
import type { CellSet } from '@shared/table-edit'
import type { DiffRow } from '@shared/sheet-diff'
import { useSheetDiff } from '@/lib/sheet-diff-async'
import { headerOf } from '@shared/table-struct'
import { fieldNames } from '@shared/table-agent'
import { tablesApi, type TableHistory } from '@/lib/tables-api'
import { cn } from '@/lib/utils'
import { Modal, ModalHeader } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { IconButton } from '@/components/ui/icon-button'
import { DiffSummary, SheetDiffView } from './SheetDiffView'

/** 选中的是「本地改动」还是第几个提交 */
type Pick = 'local' | number

const sideOf = (schema: TableSchema, path: string, sheet: SheetData | undefined) => {
  if (!sheet) return { rows: [] as string[][], from: 0, names: [] as string[] }
  const h = headerOf(schema, path, sheet)
  return { rows: sheet.rows, from: h.start + h.roles.length, names: fieldNames(sheet.rows, h) }
}

/**
 * 版本差异：左边是这个文件的版本记录（Git / P4 / SVN），右边是格子级差异。
 * 「本地改动」= 最近一次提交 ↔ 现在页面上的内容（含还没保存的改动），改过的行能一键还原成旧值（就是一次普通编辑）；
 * 点一个提交 = 它的上一版 ↔ 它。只看当前这张工作表
 */
export function TableHistoryDialog({
  open,
  onClose,
  projectId,
  path,
  sheet,
  rows,
  schema,
  onRestore,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  path: string
  /** 现在看的工作表名 */
  sheet: string
  /** 现在页面上的内容（含没保存的改动） */
  rows: string[][]
  schema: TableSchema
  /** 还原：把这些格子改回旧值；只读时不传 */
  onRestore?: (cells: CellSet[]) => void
}) {
  const [hist, setHist] = useState<TableHistory | null>(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState<Pick>('local')
  const [only, setOnly] = useState(true)
  const [pair, setPair] = useState<{ key: string; a: SheetData[]; b: SheetData[] | null } | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    tablesApi
      .history(projectId, path)
      .then(setHist)
      .catch((e) => setError((e as Error).message))
  }, [projectId, path])
  // 取两版内容：本地改动只取基准版
  const want = !hist
    ? null
    : pick === 'local'
      ? { key: 'local', a: hist.base, b: '' }
      : { key: String(pick), a: hist.revs[pick + 1]?.id ?? '', b: hist.revs[pick]?.id ?? '' }
  const wantKey = want ? `${want.key}:${want.a}:${want.b}` : ''
  useEffect(() => {
    if (!want || (hist?.vcs === 'none' && pick === 'local')) return
    let live = true
    setLoading(true)
    setError('')
    const get = (rev: string) => (rev ? tablesApi.at(projectId, path, rev).then((r) => r.sheets) : Promise.resolve([]))
    Promise.all([get(want.a), want.b ? get(want.b) : Promise.resolve(null)])
      .then(([a, b]) => live && setPair({ key: wantKey, a, b }))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // 按要取的两个版本变化重取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, projectId, path])

  const ready = pair?.key === wantKey ? pair : null
  const sides = useMemo(() => {
    if (!ready) return null
    const a = sideOf(
      schema,
      path,
      ready.a.find((s) => s.name === sheet) ?? (ready.a.length === 1 ? ready.a[0] : undefined),
    )
    const bSheet = ready.b
      ? (ready.b.find((s) => s.name === sheet) ?? (ready.b.length === 1 ? ready.b[0] : undefined))
      : { name: sheet, rows }
    const b = sideOf(schema, path, bSheet)
    return { a, b }
  }, [ready, schema, path, sheet, rows])
  // 差异在后台线程算：大表没有主键时要做 LCS，放主线程上算页面会卡
  const { diff, error: diffError } = useSheetDiff(sides, schema.style.key)

  const restore = (row: DiffRow) => {
    if (!sides || !diff || row.kind !== 'mod' || row.a === undefined || row.b === undefined) return
    const { a } = sides
    onRestore?.(
      (row.cols ?? []).map((c) => ({
        r: row.b!,
        c,
        v: diff.colMap[c] < 0 ? '' : (a.rows[row.a!]?.[diff.colMap[c]] ?? ''),
      })),
    )
  }
  const revs = hist?.revs ?? []
  const title =
    pick === 'local'
      ? t('{base} → 本地', { base: revs[0]?.label ?? t('最近一次提交') })
      : t('{from} → {to}', { from: revs[pick + 1]?.label ?? t('（新建）'), to: revs[pick]?.label ?? '' })
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={null}
      bare
      closeOnOutside
      className="h-[min(820px,calc(100dvh-3.75rem))] max-w-[1280px]"
    >
      <ModalHeader icon={History} title={t('版本差异')} meta={`${path} · ${sheet}`} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t('版本记录')}
          className="thin-scroll flex w-72 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2"
        >
          {!hist && !error && (
            <div className="flex justify-center p-6 text-subtle">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {hist?.vcs === 'none' && (
            <p className="px-2 py-4 text-footnote leading-relaxed text-subtle">
              {t('这个项目没有用 Git / P4 / SVN 管理，看不了版本差异。')}
            </p>
          )}
          {hist && hist.vcs !== 'none' && (
            <>
              <p className="px-2 pt-1 pb-1.5 text-caption text-subtle">
                {t('{vcs} · 选一个版本看它改了什么', { vcs: hist.vcs.toUpperCase() })}
              </p>
              <RevItem
                active={pick === 'local'}
                onClick={() => setPick('local')}
                label={t('本地改动')}
                meta={t('含还没保存的')}
                message={t('最近一次提交 ↔ 现在页面上的内容')}
              />
              {revs.map((r, i) => (
                <RevItem
                  key={r.id}
                  active={pick === i}
                  onClick={() => setPick(i)}
                  label={r.label}
                  meta={r.time ? new Date(r.time).toLocaleString() : ''}
                  message={[r.author, r.message].filter(Boolean).join(' · ')}
                />
              ))}
              {hist.error && <p className="px-2 py-2 text-caption text-danger">{hist.error}</p>}
            </>
          )}
        </nav>
        <section aria-label={t('差异')} className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
            <span className="font-mono text-body">{title}</span>
            {diff && <DiffSummary diff={diff} />}
            <span className="flex-1" />
            <Segmented
              label={t('显示')}
              size="sm"
              value={only ? 'only' : 'all'}
              onChange={(v) => setOnly(v === 'only')}
              options={[
                { id: 'only', label: t('只看变化') },
                { id: 'all', label: t('全部行') },
              ]}
            />
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            {error || diffError ? (
              <p className="p-4 text-body text-danger">{error || diffError}</p>
            ) : loading || !sides || !diff ? (
              hist?.vcs === 'none' ? null : (
                <div className="flex justify-center p-8 text-subtle">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )
            ) : (
              <SheetDiffView
                a={sides.a.rows}
                b={sides.b.rows}
                diff={diff}
                names={sides.b.names}
                onlyChanges={only}
                rowAction={
                  pick === 'local' && onRestore
                    ? (row) =>
                        row.kind === 'mod' ? (
                          <IconButton icon={Undo2} size="sm" label={t('这一行改回旧值')} onClick={() => restore(row)} />
                        ) : null
                    : undefined
                }
              />
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function RevItem({
  active,
  onClick,
  label,
  meta,
  message,
}: {
  active: boolean
  onClick: () => void
  label: string
  meta: string
  message: string
}) {
  return (
    <button
      type="button"
      aria-current={active || undefined}
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer flex-col gap-0.5 rounded-(--c-row-radius) px-2.5 py-2 text-left hover:bg-hover',
        active && 'bg-sel hover:bg-sel',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-body font-medium">{label}</span>
        <span className="ml-auto truncate text-caption text-subtle">{meta}</span>
      </span>
      {message && <span className="truncate text-footnote text-muted">{message}</span>}
    </button>
  )
}
