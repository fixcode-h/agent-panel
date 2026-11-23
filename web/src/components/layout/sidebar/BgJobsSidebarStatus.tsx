import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleSlash, Loader2, XCircle } from 'lucide-react'
import { bgJobsContract as C } from '@shared/api-contract/bg-jobs'
import type { BgJob } from '@shared/jobs/types'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/children/activity'
import { call } from '@/lib/api/call'
import { useBgJobs } from '@/lib/live/bg-jobs'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { BackgroundStatus } from '@/components/ui/background-status'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { StatusPill } from '@/components/ui/status-pill'

/**
 * 侧栏底部的后台作业（ADR 0075）：有作业在跑时出现一行汇总，点开是全部作业的列表，能看日志、能取消。
 * 只有一条在跑时直接显示它的标题和进度；几条一起时显示条数
 */
export function BgJobsSidebarStatus() {
  const [jobs] = useBgJobs()
  const [open, setOpen] = useState(false)
  const running = jobs.filter((j) => j.status === 'running')
  return (
    <>
      {running.length > 0 && (
        <BackgroundStatus
          label={running.length === 1 ? running[0].title : t('{n} 个后台任务在跑', { n: running.length })}
          detail={running.length === 1 ? progressText(running[0]) : undefined}
          value={running.length === 1 ? running[0].done : undefined}
          max={running.length === 1 ? running[0].total : undefined}
          onClick={() => setOpen(true)}
        />
      )}
      <BgJobsDialog open={open} onOpenChange={setOpen} jobs={jobs} />
    </>
  )
}

const progressText = (j: BgJob) =>
  j.total ? `${Math.min(100, Math.round(((j.done ?? 0) / j.total) * 100))}%` : (j.phase ?? '')

function StatusIcon({ job }: { job: BgJob }) {
  if (job.status === 'running') return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
  if (job.status === 'done') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
  if (job.status === 'canceled') return <CircleSlash className="h-3.5 w-3.5 shrink-0 text-subtle" />
  return <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
}

/** 全部后台作业：左边列表，右边选中那条的日志（跑着的跟着长） */
export function BgJobsDialog({
  open,
  onOpenChange,
  jobs,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  jobs: BgJob[]
}) {
  const [sel, setSel] = useState<string>()
  const cur = jobs.find((j) => j.id === sel) ?? jobs[0]
  const cancel = async (j: BgJob) => {
    try {
      const r = await call(C.cancel, { params: { id: j.id }, body: {} })
      if (!r.ok) toast.error(r.info)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const clear = async () => {
    try {
      await call(C.clear, { body: {} })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('后台任务')} size="lg" closeOnOutside>
      {jobs.length ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto">
            {jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => setSel(j.id)}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-footnote hover:bg-hover',
                  cur?.id === j.id && 'bg-sel',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusIcon job={j} />
                  <span className="min-w-0 flex-1 truncate">{j.title}</span>
                </span>
                <span className="truncate pl-5.5 text-caption text-subtle">
                  {[
                    j.source === 'panel' ? '' : j.source,
                    j.status === 'running'
                      ? progressText(j)
                      : timeAgo(new Date(j.endedAt ?? j.startedAt).toISOString()),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            ))}
            {jobs.some((j) => j.status !== 'running') && (
              <Button variant="ghost" size="sm" className="mt-1 self-start" onClick={clear}>
                {t('清除已结束的')}
              </Button>
            )}
          </div>
          {cur && <JobDetail job={cur} onCancel={() => cancel(cur)} />}
        </div>
      ) : (
        <p className="py-10 text-center text-footnote text-subtle">{t('没有后台任务')}</p>
      )}
    </Modal>
  )
}

function JobDetail({ job, onCancel }: { job: BgJob; onCancel: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const next = useRef(0)
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    setLines([])
    next.current = 0
  }, [job.id])
  // 日志按行号增量取：作业状态推送时（进度、结束）顺带补一次；跑着的作业日志多、不推行数
  useEffect(() => {
    let alive = true
    call(C.log, { params: { id: job.id }, query: { from: String(next.current) } })
      .then((r) => {
        if (!alive) return
        next.current = r.next
        if (r.lines.length) setLines((old) => [...old, ...r.lines].slice(-4000))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [job.id, job.status, job.done, job.phase, job.lines])
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium">{job.title}</span>
        {job.status === 'running' ? (
          <StatusPill tone="run" spin>
            {job.phase || t('进行中')}
          </StatusPill>
        ) : job.status === 'failed' ? (
          <StatusPill tone="err">{t('失败')}</StatusPill>
        ) : job.status === 'canceled' ? (
          <StatusPill tone="idle">{t('已取消')}</StatusPill>
        ) : (
          <StatusPill tone="ok">{t('完成')}</StatusPill>
        )}
        {job.cancelable && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t('取消')}
          </Button>
        )}
      </div>
      {job.info && <p className={cn('text-footnote', job.status === 'failed' && 'text-danger')}>{job.info}</p>}
      <pre
        ref={box}
        className="min-h-40 flex-1 overflow-auto rounded-md border bg-panel p-2.5 font-mono text-caption whitespace-pre-wrap"
      >
        {lines.length ? lines.join('\n') : t('还没有日志')}
      </pre>
    </div>
  )
}
