import { FileSearch } from 'lucide-react'
import type { Task } from '@shared/schema'
import { bugStage } from '@shared/bug-diagnosis'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { useDiagnosisWindow } from './diagnosis-window'
import { ConvChangesCard } from './TurnChanges'

/**
 * 用户报的 Bug 修完（或停下）以后，对话最后一段下面留一个诊断报告的入口（用户 2026-11-05 要的）：
 * 交报告那一行早就收进折叠了，想回看各版报告时不用去翻。打开的弹窗只读（最新一版不在等你时没有操作），
 * 右上角下拉能切到任意一版。还在等你确认时运行区有「诊断报告」那一行，这里不重复
 */
export function BugReportCard({ task }: { task: Pick<Task, 'id' | 'title' | 'bug' | 'diagnoses' | 'bugCase'> }) {
  const { open, dialog } = useDiagnosisWindow(task)
  const list = task.diagnoses ?? []
  const last = list.at(-1)
  if (!task.bug || !last || last.status === 'pending') return null
  return (
    <div className="my-1 flex h-9 items-center gap-2 rounded-xl border bg-card px-3.5 text-body">
      <FileSearch className="h-3.5 w-3.5 shrink-0 text-subtle" />
      <span className="min-w-0 truncate font-medium text-fg">{t('诊断报告')}</span>
      <span className="min-w-0 truncate text-footnote text-subtle">
        {t('共 {n} 版', { n: list.length })} · {bugStage(task)}
      </span>
      <Button size="sm" variant="secondary" className="ml-auto h-6 shrink-0 px-2 text-xs" onClick={() => open(task)}>
        {t('查看报告')}
      </Button>
      {dialog}
    </div>
  )
}

/** 对话停下以后挂在最后一段下面的卡片：整个对话改了哪些文件，用户报的 Bug 再加诊断报告的入口 */
export function ConvTailCards({ task }: { task: Task }) {
  return (
    <>
      <ConvChangesCard task={task} />
      <BugReportCard task={task} />
    </>
  )
}
