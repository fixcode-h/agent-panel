import { useState } from 'react'
import { toast } from '@/lib/toast'
import { ArrowRight, Loader2, Workflow as WorkflowIcon } from 'lucide-react'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { handoffPrompt, isDefaultWorkflow, parseNext, type NextWorkflow } from '@shared/builtin/default'
import { taskSummary } from '@shared/task'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'

/**
 * 「默认」工作流的结果下面：Agent 推荐的下一步工作流，点一下就新建任务执行它，
 * 原始需求和这次的结果一起交过去。只显示用户现在还有的工作流
 */
export function NextWorkflows({ task }: { task: Task }) {
  const { workflows, upsertTask } = useData()
  const { go } = useNav()
  const [busy, setBusy] = useState('')
  if (task.mode !== 'workflow' || !isDefaultWorkflow(task.workflowId) || task.status === 'running') return null

  // 最近一次给出推荐的回复（追加要求后主 Agent 可能重新推荐）
  const msgs = task.messages
  const hit = [...msgs].reverse().find((m) => m.role === 'agent' && m.text.includes('```next-workflows'))
  if (!hit) return null
  const recs = parseNext(hit.text, workflows)
  if (!recs.length) return null
  // 结果：同一个节点（或同一轮回复）的全部文字
  const result = msgs
    .filter((m) => m.role === 'agent' && m.step === hit.step && m.text.trim())
    .map((m) => m.text)
    .join('\n\n')
  const original = msgs.find((m) => m.role === 'user')?.text ?? ''

  const run = async (r: NextWorkflow) => {
    setBusy(r.id)
    try {
      const created = await api.createTask({
        projectId: task.projectId,
        mode: 'workflow',
        workflowId: r.id,
        agentId: '',
        cli: '',
        model: '',
        effort: '',
        params: {},
        prompt: handoffPrompt(r, original, result),
        attachments: msgs.find((m) => m.role === 'user')?.attachments ?? [],
        isolate: false,
        askUser: task.askUser,
      })
      upsertTask(taskSummary(created))
      go({ page: 'projects', id: created.projectId, sub: created.id })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <section aria-label={t('推荐的下一步')} className="flex flex-col gap-2">
      <h3 className="px-1 text-[0.78125rem] font-medium text-muted">{t('推荐的下一步')}</h3>
      <div className="flex flex-col overflow-hidden rounded-xl border border-line-strong bg-card shadow-card">
        {recs.map((r, i) => {
          const w = workflows.find((x) => x.id === r.id)!
          return (
            <button
              key={r.id}
              type="button"
              disabled={!!busy}
              onClick={() => run(r)}
              title={r.prompt || undefined}
              className={cn(
                'group flex cursor-pointer items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-sel disabled:cursor-default',
                i > 0 && 'border-t border-line',
              )}
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-accent">
                <WorkflowIcon className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[0.84375rem] font-medium">{w.name}</span>
                {(r.reason || w.description) && (
                  <span className="line-clamp-2 text-[0.78125rem] text-muted">{r.reason || w.description}</span>
                )}
              </span>
              <span className="mt-1 flex shrink-0 items-center gap-1 text-[0.78125rem] text-subtle transition-colors group-hover:text-accent">
                {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('执行')}
                {busy !== r.id && <ArrowRight className="h-3.5 w-3.5" />}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
