import { FileSearch } from 'lucide-react'
import type { Task } from '@shared/schema'
import { bugStage } from '@shared/bug-diagnosis'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useDiagnosisWindow } from './diagnosis-window'
import { plainRow } from './ChildrenBar'

/**
 * 用户报的 Bug 修完（或停下）以后，诊断报告的入口：交报告那一行早就收进折叠了，想回看各版报告时不用去翻。
 * 固定在输入框上方的状态栏里（和计划、子任务、子对话同一块，用户 2026-11-05 要的），不跟着消息流滚走。
 * 打开的弹窗只读（最新一版不在等你时没有操作），右上角下拉能切到任意一版。
 * 还在等你确认时运行区有「诊断报告」那一行，这里不重复
 */
export function BugReportRow({ task }: { task: Pick<Task, 'id' | 'title' | 'bug' | 'diagnoses' | 'bugCase'> }) {
  const { open, dialog } = useDiagnosisWindow(task)
  const list = task.diagnoses ?? []
  const last = list.at(-1)
  if (!task.bug || !last || last.status === 'pending') return null
  return (
    <div className="shrink-0 px-3 md:px-6">
      <div className="mx-auto max-w-(--content-w)">
        <div data-status-row="bug-report" className={cn(plainRow, 'mb-1 flex-nowrap')}>
          {/* 整段字也能点开报告，和子对话、计划那几行一样是入口 */}
          <button
            type="button"
            onClick={() => open(task)}
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-body text-muted transition-colors hover:bg-sel hover:text-fg"
          >
            <FileSearch className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="shrink-0 font-medium">{t('诊断报告')}</span>
            <span className="min-w-0 truncate text-xs text-subtle">
              {t('共 {n} 版', { n: list.length })} · {bugStage(task)}
            </span>
          </button>
          <Button size="sm" variant="secondary" className="h-6 shrink-0 px-2 text-xs" onClick={() => open(task)}>
            {t('查看报告')}
          </Button>
          {dialog}
        </div>
      </div>
    </div>
  )
}
