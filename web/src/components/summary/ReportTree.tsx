/**
 * 左侧的报告树：全部报告按日期分组（按天的挂在那一天，按周的挂在那一周），一个日期下可以有多份。
 * 最近几组默认展开，更早的收起；点组头展开 / 收起，搜索时全部展开只留命中的。
 * 「新建」回到右边的提炼面板，右键一份报告可以复制或删除。
 */
import { useMemo, useState } from 'react'
import { CalendarDays, CalendarRange, Copy, FileText, Layers, Trash2 } from 'lucide-react'
import {
  groupReports,
  reportChars,
  reportCounts,
  reportName,
  summaryPeriod,
  windowLabel,
  type ReportGroup,
  type SummaryRecord,
} from '@shared/summary'
import { hhmm } from '@shared/datetime'
import { t } from '@shared/i18n'
import { GroupHeader, ListEmpty, ListGroup, ListItem, ListPane } from '@/components/layout/ListPane'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/menu'

/** 默认展开最近几组：再往前的日期多数时候不看，收起来列表不会拉得很长 */
const OPEN_GROUPS = 5

/** 组头文字：今天 / 昨天 / 本周加上相对说法，其余直接写日期 */
function groupLabel(g: ReportGroup, now: Date) {
  const label = windowLabel(g.grain, g.from)
  if (g.grain === 'week') return summaryPeriod('week', now).fromDay === g.from ? t('本周 · {label}', { label }) : label
  const today = summaryPeriod('day', now).fromDay
  const yesterday = summaryPeriod('day', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)).fromDay
  if (g.from === today) return t('今天 · {label}', { label })
  if (g.from === yesterday) return t('昨天 · {label}', { label })
  return label
}

/** 一份报告的副标题：生成时间 + 需求 / Bug 条数（老报告没有分项时写字数） */
function reportMeta(r: SummaryRecord) {
  const at = hhmm(new Date(r.createdAt))
  const c = reportCounts(r)
  if (c) return t('{time} · 需求 {need} · Bug {bug}', { time: at, need: c.need, bug: c.bug })
  return t('{time} · {n} 字', { time: at, n: reportChars(r.md) })
}

export function ReportTree({
  reports,
  loaded,
  selected,
  onSelect,
  onNew,
  onCopy,
  onDelete,
}: {
  reports: SummaryRecord[]
  loaded: boolean
  /** 当前打开的报告；在提炼面板时为空 */
  selected: string
  onSelect: (id: string) => void
  onNew: () => void
  onCopy: (r: SummaryRecord) => void
  onDelete: (r: SummaryRecord) => void
}) {
  const [query, setQuery] = useState('')
  /** 用户点过的组：和默认展开状态相反（默认展开的点了就收起，反之亦然） */
  const [flipped, setFlipped] = useState<Set<string>>(new Set())
  const now = new Date()
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = (r: SummaryRecord) =>
      !q || reportName(r).toLowerCase().includes(q) || r.md.toLowerCase().includes(q) || r.day.includes(q)
    return groupReports(reports.filter(hit))
  }, [reports, query])

  const toggle = (key: string) =>
    setFlipped((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <ListPane
      title={t('工作总结')}
      count={reports.length}
      onNew={onNew}
      query={query}
      onQuery={setQuery}
      placeholder={t('搜索报告内容')}
      compact
      footer={
        <p className="text-footnote leading-relaxed text-subtle">{t('按日期归档；右键一份报告可以复制或删除。')}</p>
      }
    >
      {!loaded ? (
        <p className="px-2 py-6 text-body text-subtle">{t('读取中…')}</p>
      ) : !groups.length ? (
        <ListEmpty>{query ? t('没有符合的报告。') : t('还没有报告，在右边提炼一份。')}</ListEmpty>
      ) : (
        groups.map((g, i) => {
          // 打开的报告所在的组总是展开：从别处跳过来时能看到它在哪
          const holdsSelected = g.reports.some((r) => r.id === selected)
          const collapsed = !query && !holdsSelected && i >= OPEN_GROUPS !== flipped.has(g.key)
          return (
            <ListGroup
              key={g.key}
              groupId={g.key}
              label={groupLabel(g, now)}
              collapsed={collapsed}
              header={
                <GroupHeader
                  compact
                  label={
                    <span className="flex items-center gap-1.5">
                      {g.grain === 'week' ? (
                        <CalendarRange className="h-3 w-3" />
                      ) : (
                        <CalendarDays className="h-3 w-3" />
                      )}
                      {groupLabel(g, now)}
                    </span>
                  }
                  count={g.reports.length}
                  collapsed={collapsed}
                  onToggle={() => toggle(g.key)}
                />
              }
            >
              {g.reports.map((r) => (
                <ListItem
                  key={r.id}
                  compact
                  selected={r.id === selected}
                  onClick={() => onSelect(r.id)}
                  leading={
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sel/70 text-subtle">
                      {r.source === 'reports' ? (
                        <Layers className="h-3.5 w-3.5" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                    </span>
                  }
                  title={reportName(r)}
                  subtitle={reportMeta(r)}
                  monoSubtitle={false}
                  menu={
                    <>
                      <ContextMenuItem onSelect={() => onCopy(r)}>
                        <Copy className="h-4 w-4" />
                        {t('复制 Markdown')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem danger onSelect={() => onDelete(r)}>
                        <Trash2 className="h-4 w-4" />
                        {t('删除')}
                      </ContextMenuItem>
                    </>
                  }
                />
              ))}
            </ListGroup>
          )
        })
      )}
    </ListPane>
  )
}
