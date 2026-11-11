import { useMemo, useState } from 'react'
import { Check, Lightbulb } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableSchema } from '@shared/tables'
import type { ColInfo } from '@shared/table-struct'
import { columnStats, inferRules, STATS_MAX } from '@shared/table-stats'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'

/**
 * 「统计这一列」：唯一值、空值、出现最多的 10 个值、最小最大；下面按数据给几条规则建议（范围、枚举、必填），
 * 点「设上」就写进列结构（项目的表格结构文件）。不用 AI，结果确定；超过 5 万行只看前面的，标「抽样」
 */
export function ColumnStatsDialog({
  rows,
  from,
  info,
  file,
  schema,
  onSchema,
  onClose,
}: {
  rows: string[][]
  from: number
  info: ColInfo
  file: string
  schema: TableSchema
  onSchema: (s: TableSchema) => void
  onClose: () => void
}) {
  const st = useMemo(
    () => columnStats(rows, from, info.col, info.list ? info.sep : undefined),
    [rows, from, info.col, info.list, info.sep],
  )
  const hints = useMemo(() => inferRules(st, info, file), [st, info, file])
  const [done, setDone] = useState<Set<string>>(new Set())
  const cell = 'flex flex-col gap-0.5 rounded-md bg-sel/60 px-3 py-2'
  const num = (n: number) => n.toLocaleString()
  const most = st.top[0]?.[1] ?? 1
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('统计 {field}', { field: info.field })} closeOnOutside>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 text-footnote sm:grid-cols-4">
          <div className={cell}>
            <span className="text-subtle">{t('行数')}</span>
            <span className="text-body text-fg tabular-nums">
              {num(st.rows)}
              {st.sampled && (
                <Badge className="ml-1.5 h-4 px-1.5" title={t('只看了前 {n} 行', { n: num(STATS_MAX) })}>
                  {t('抽样')}
                </Badge>
              )}
            </span>
          </div>
          <div className={cell}>
            <span className="text-subtle">{t('空着')}</span>
            <span className="text-body text-fg tabular-nums">{num(st.empty)}</span>
          </div>
          <div className={cell}>
            <span className="text-subtle">{t('不同的值')}</span>
            <span className="text-body text-fg tabular-nums">{num(st.unique)}</span>
          </div>
          <div className={cell}>
            <span className="text-subtle">{t('最小 ~ 最大')}</span>
            <span className="truncate text-body text-fg tabular-nums">
              {st.min !== undefined ? `${st.min} ~ ${st.max}` : '—'}
            </span>
          </div>
        </div>
        {st.top.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-footnote font-medium text-subtle">{t('出现最多的值')}</h3>
            <ul aria-label={t('出现最多的值')} className="flex flex-col gap-0.5">
              {st.top.map(([v, n]) => (
                <li
                  key={v}
                  className="relative flex h-6 items-center gap-2 overflow-hidden rounded-sm px-2 text-footnote"
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-accent/10"
                    style={{ width: `${(n / most) * 100}%` }}
                  />
                  <span className="relative min-w-0 flex-1 truncate font-mono text-fg">{v}</span>
                  <span className="relative text-subtle tabular-nums">{num(n)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 text-footnote font-medium text-subtle">
            <Lightbulb className="h-3.5 w-3.5" />
            {t('按数据推断的规则')}
          </h3>
          {hints.length ? (
            hints.map((h) => (
              <div key={h.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-footnote">
                <span className="min-w-0 flex-1 text-fg">{h.label}</span>
                {done.has(h.id) ? (
                  <span className="flex items-center gap-1 text-success">
                    <Check className="h-3.5 w-3.5" />
                    {t('已设上')}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6"
                    onClick={() => {
                      onSchema(h.apply(schema))
                      setDone((d) => new Set(d).add(h.id))
                    }}
                  >
                    {t('设上')}
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="text-footnote text-subtle">{t('没有要补的规则（或者已经设过了）')}</p>
          )}
        </section>
      </div>
    </Modal>
  )
}
