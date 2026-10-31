/** 输入框位置上替代输入框的一行：导入的只读任务、已收尾的子对话 */
import { useState } from 'react'
import { CheckCircle2, FileInput, Loader2, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { api, type TaskPage } from '@/lib/api'
import type { Task } from '@shared/schema'
import { toast } from '@/lib/toast'

/**
 * 已收尾（已解决）的子对话：输入框的位置换成这一行，点「重新打开」才重新出现输入框（用户 2026-10-31）。
 * 重新打开 = 取消已解决，再用 --resume 把它的 CLI 拉起来停在等下一句（和菜单「激活 Agent」同一条路）。
 * 拉不起来（没有会话、独立分支目录已回收、CLI 不支持停在等待上）不算错：发第一句时照样按 --resume 续接
 */
export function ResolvedBar({ taskId, onTask }: { taskId: string; onTask: (task: TaskPage) => void }) {
  const [busy, setBusy] = useState(false)
  const reopen = async () => {
    if (busy) return
    setBusy(true)
    try {
      onTask(await api.resolveTask(taskId, false))
      // 返回的是列表摘要（不带消息）：不拿它覆盖页面，CLI 起来后的状态由推送带回来
      await api.activateAgentSummary(taskId).catch(() => {})
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mx-auto flex max-w-(--content-w) items-center gap-3 rounded-2xl border border-line-strong bg-card px-4 py-2.5 shadow-card">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-text" />
      <span className="min-w-0 flex-1 text-[0.8125rem]">
        <span className="font-medium text-fg">{t('此子对话已收尾。')}</span>{' '}
        <span className="text-subtle">{t('请重新打开以发送更多消息。')}</span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="shrink-0 rounded-lg"
        disabled={busy}
        onClick={() => void reopen()}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('重新打开')}
      </Button>
    </div>
  )
}

/** 从文件导入的任务：只能查看，输入框换成这一行 */
export function ImportedBar({ task, onAnalyze }: { task: Task; onAnalyze: () => void }) {
  const info = task.imported!
  return (
    <div className="mx-auto flex max-w-(--content-w) items-center gap-3 rounded-2xl border border-line-strong bg-card px-4 py-3 shadow-card">
      <FileInput className="h-4 w-4 shrink-0 text-accent-text" />
      <span className="min-w-0 flex-1 text-[0.8125rem] text-muted">
        {t('这是从文件导入的任务（{at} 导出{app}），只能查看，不能继续执行。', {
          at: (info.exportedAt || info.at).slice(0, 16).replace('T', ' '),
          app: info.app ? t('，面板 {v}', { v: info.app }) : '',
        })}
      </span>
      <Button size="sm" variant="secondary" className="shrink-0 rounded-lg" onClick={onAnalyze}>
        <Sparkles className="h-3.5 w-3.5 text-accent-text" />
        {t('AI 分析')}
      </Button>
    </div>
  )
}
