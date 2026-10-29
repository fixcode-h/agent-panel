/**
 * 右边打开的一份报告：头部写范围、来源和规模，正文可以预览 / 编辑（自动保存）、复制、删除；
 * 下面是从这份报告提炼候选教训的草稿区。
 */
import { useState } from 'react'
import { Copy, FileText, Layers, Trash2 } from 'lucide-react'
import {
  formatDuration,
  reportChars,
  reportCounts,
  reportGrain,
  reportName,
  reportSpan,
  windowLabel,
  type SummaryRecord,
} from '@shared/summary'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useAutosave } from '@/lib/useAutosave'
import type { ReportMode } from '@/lib/summary-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { IconButton } from '@/components/ui/icon-button'
import { DetailHeader } from '@/components/layout/Detail'
import { Markdown } from '@/components/tasks/Markdown'
import { LessonDrafts } from './LessonDrafts'

const NO_TEAM = new Set<string>()

export function ReportView({
  report,
  mode,
  onMode,
  onCopy,
  onSaved,
  onDelete,
}: {
  report: SummaryRecord
  /** 预览 / 编辑由页面记着：切页面回来后还是之前那个 tab */
  mode: ReportMode
  onMode: (mode: ReportMode) => void
  onCopy: (md: string) => void
  /** 保存成功后把新正文交回去：树里的快照跟着变，不然再点回这份会拿旧内容 */
  onSaved: (md: string) => void
  onDelete: () => void
}) {
  const [md, setMd] = useState(report.md)
  // 组件按报告 id 重挂（调用方给 key），切走时补存的也是这份
  const save = useAutosave(
    md,
    async (v) => {
      const r = await api.saveSummary(report.id, v)
      onSaved(v)
      return r
    },
    true,
  )
  const grain = reportGrain(report)
  const span = reportSpan(report)
  const counts = reportCounts(report)
  const duration = formatDuration(report.durationMs)
  const subtitle = [
    report.source === 'reports'
      ? t('从 {n} 份报告汇总', { n: report.reportCount })
      : [report.projectNames.join('、'), report.taskCount ? t('{n} 个对话', { n: report.taskCount }) : '']
          .filter(Boolean)
          .join(' · '),
    t('{n} 字', { n: reportChars(md) }),
    duration && t('提炼耗时 {time}', { time: duration }),
    new Date(report.createdAt).toLocaleString(),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto" aria-label={t('报告')}>
      <DetailHeader
        leading={
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
            {report.source === 'reports' ? <Layers className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
          </span>
        }
        title={windowLabel(grain, span.from)}
        meta={
          <>
            <Badge tone="accent">{grain === 'week' ? t('周报') : t('日报')}</Badge>
            <Badge>{report.source === 'reports' ? t('来自报告') : t('来自对话')}</Badge>
            {counts && <Badge>{t('需求 {need} · Bug {bug}', { need: counts.need, bug: counts.bug })}</Badge>}
          </>
        }
        subtitle={subtitle || reportName(report)}
        save={save}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => onCopy(md)}>
              <Copy className="h-3.5 w-3.5" />
              {t('复制')}
            </Button>
            <IconButton icon={Trash2} label={t('删除这份报告')} onClick={onDelete} />
          </>
        }
      />
      <div className="flex w-full max-w-[920px] flex-col gap-4 px-4 pt-5 pb-10 md:px-8">
        <Card as="section" aria-label={t('报告内容')}>
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <Segmented
              label={t('报告视图')}
              size="sm"
              value={mode}
              onChange={onMode}
              options={[
                { id: 'preview', label: t('预览') },
                { id: 'edit', label: t('编辑') },
              ]}
            />
            <span className="ml-auto text-xs text-subtle">{t('编辑后自动保存')}</span>
          </div>
          {mode === 'edit' ? (
            <Textarea
              aria-label={t('报告正文')}
              value={md}
              onChange={(e) => setMd(e.target.value)}
              className="min-h-[480px] rounded-none border-0 bg-transparent px-5 py-4 font-mono text-[0.8125rem] leading-relaxed focus:ring-0"
            />
          ) : (
            // 正文限宽：一行太长不好读；左缘和卡片内边距对齐，不居中
            <div className="max-w-[76ch] px-5 py-4">
              <Markdown text={md} teamNames={NO_TEAM} />
            </div>
          )}
        </Card>
        <LessonDrafts reportId={report.id} day={span.to} />
      </div>
    </main>
  )
}
