import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CellAt } from '@shared/table-blame'
import { tablesApi, type CellHistory } from '@/lib/tables-api'
import { Modal } from '@/components/ui/modal'

/** 一格的值：空格子和「那时还没有这一行」分开写 */
function Val({ v, tone }: { v: string | null; tone: 'old' | 'new' }) {
  if (v === null) return <span className="text-subtle italic">{t('还没有')}</span>
  if (v === '') return <span className="text-subtle italic">{t('空')}</span>
  return (
    <span className={tone === 'old' ? 'text-danger line-through' : 'text-success'} title={v}>
      {v}
    </span>
  )
}

/**
 * 一格的历史：哪几次提交改过这一格、从什么改成什么。按主键找同一行、按字段名找同一列，
 * 插删过行、挪过列也对得上；版本在服务端逐个取出来比，页面只拿结果
 */
export function CellHistoryDialog({
  projectId,
  path,
  at,
  title,
  onClose,
}: {
  projectId: string
  path: string
  at: CellAt
  title: string
  onClose: () => void
}) {
  const [res, setRes] = useState<CellHistory | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    tablesApi
      .cellHistory(projectId, path, at)
      .then((r) => live && setRes(r))
      .catch((e) => live && setError((e as Error).message))
    return () => {
      live = false
    }
    // 弹窗打开时取一次；at 每次渲染是新对象，按内容比没必要
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path])
  const err = error || res?.error || (res?.vcs === 'none' ? t('这个文件不在版本管理里，没有历史') : '')
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} size="lg">
      {err ? (
        <p className="text-body text-danger">{err}</p>
      ) : !res ? (
        <div className="flex items-center justify-center gap-2 p-6 text-footnote text-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('正在逐个版本找这一格……')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-caption text-subtle">
            {at.keyField
              ? t('按 {key} = {v} 找同一行，看了最近 {n} 个版本', { key: at.keyField, v: at.key ?? '', n: res.scanned })
              : t('没有主键，按行号找同一行（插删过行会对不上），看了最近 {n} 个版本', { n: res.scanned })}
          </p>
          {!res.changes.length ? (
            <p className="py-6 text-center text-body text-subtle">{t('这几个版本里这一格没改过')}</p>
          ) : (
            <div role="list" aria-label={t('改过这一格的提交')} className="flex flex-col gap-px">
              {res.changes.map((c) => (
                <div
                  role="listitem"
                  key={c.rev.id}
                  className="flex flex-col gap-0.5 rounded-(--c-row-radius) px-2.5 py-1.5 hover:bg-hover"
                >
                  <div className="flex items-center gap-2 text-caption text-subtle">
                    <span className="font-mono">{c.rev.label}</span>
                    <span>{c.rev.author}</span>
                    <span>{c.rev.time ? new Date(c.rev.time).toLocaleString() : ''}</span>
                    <span className="min-w-0 flex-1 truncate text-muted" title={c.rev.message}>
                      {c.rev.message}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-footnote">
                    <span className="max-w-[45%] min-w-0 truncate">
                      <Val v={c.from} tone="old" />
                    </span>
                    <span className="text-subtle">→</span>
                    <span className="max-w-[45%] min-w-0 truncate">
                      <Val v={c.to} tone="new" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
