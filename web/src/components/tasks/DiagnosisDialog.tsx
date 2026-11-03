import { useEffect, useState } from 'react'
import { FileSearch } from 'lucide-react'
import type { Task, TaskRequest } from '@shared/schema'
import type { Diagnosis } from '@shared/bug-diagnosis-schema'
import { diagnosisMarkdown } from '@shared/bug-diagnosis'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { ReviewDialog, type NoteKind } from './ReviewDialog'

/**
 * Bug 的诊断报告（ADR 0045）：父对话派来的 Bug，子对话修之前交这份报告，用户在这里确认方案或标出疑问。
 * 审阅弹窗和工作流节点的确认是同一个（ReviewDialog），多了标注种类、多版切换；
 * 决定交给服务端记下，再把返回的话作为一条消息发给子对话（发消息那条路负责叫醒它）
 */

const KINDS: () => NoteKind[] = () => [
  { id: 'question', label: t('疑问'), placeholder: t('哪里看不明白、觉得不对，要它查清楚') },
  { id: 'change', label: t('改方案'), placeholder: t('方案要怎么改：换修法、缩小或扩大范围') },
  { id: 'info', label: t('补充信息'), placeholder: t('你知道的事实，例如什么时候开始坏的') },
]

const STATUS: Record<Diagnosis['status'], () => string> = {
  pending: () => t('等你确认'),
  questioned: () => t('你提了意见，它在再查'),
  approved: () => t('已确认，按这版方案修'),
  superseded: () => t('已作废，有更新的一版'),
}

/** 每一版的标题、正文和状态：正文按上一版补出「回答上一版的意见」 */
function versionsOf(list: Diagnosis[]) {
  return list.map((d, i) => ({
    key: String(d.version),
    label: t('第 {n} 版', { n: d.version }),
    detail: diagnosisMarkdown(d, list[i - 1]),
    status: STATUS[d.status](),
  }))
}

/** 审阅弹窗：最新一版在等确认时能确认 / 退回，否则只读（随时回看） */
export function DiagnosisDialog({
  task,
  open,
  onOpenChange,
  onDone,
}: {
  task: Pick<Task, 'id' | 'title' | 'diagnoses' | 'requests'>
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: (task: Task) => void
}) {
  const list = task.diagnoses ?? []
  const last = list.at(-1)
  if (!last) return null
  const req: Pick<TaskRequest, 'id' | 'title' | 'detail'> = {
    id: `${task.id}:${last.version}`,
    title: t('诊断报告 · {title}', { title: task.title }),
    detail: diagnosisMarkdown(last, list.at(-2)),
  }
  return (
    <ReviewDialog
      req={req}
      open={open}
      onOpenChange={onOpenChange}
      kinds={KINDS()}
      versions={versionsOf(list)}
      readOnly={last.status !== 'pending'}
      texts={{
        approve: t('确认方案，开始修'),
        revise: t('有疑问，再查'),
        hintApprove: t('方案没问题就确认，它才会开始改；有疑问先选中文字标注'),
        hintRevise: t('「有疑问，再查」把标注按编号交回，它逐条查清后交新一版'),
      }}
      onAnswer={async (allow, _text, raw) => {
        const notes = (raw?.notes ?? []).map((n) => ({
          quote: n.quote,
          comment: n.comment,
          kind: (n.kind || 'question') as 'question' | 'change' | 'info',
        }))
        const r = await api.decideDiagnosis(task.id, last.version, {
          approve: allow,
          notes,
          overall: raw?.overall ?? '',
        })
        // 决定已经记下：把话交给子对话，叫醒它接着做（在跑、在等下一句、停着都由发消息那条路处理）
        const next = await api.sendMessage(task.id, r.message).catch((e: Error) => {
          toast.error(t('方案已经记下，但没能交给子对话：{error}', { error: e.message }))
          return r.task
        })
        onDone?.(next)
      }}
    />
  )
}

/** 输入框上方的入口：诊断报告等你确认（和节点确认那一条同样式） */
export function DiagnosisEntry({
  task,
  onDone,
  className,
}: {
  task: Task
  onDone: (task: Task) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const last = task.diagnoses?.at(-1)
  if (!last) return null
  return (
    <>
      <div
        role="alertdialog"
        aria-label={t('诊断报告等你确认')}
        className={cn(
          'mx-auto mb-2 flex max-w-(--content-w) items-center gap-2.5 rounded-2xl border border-warning/50 bg-card px-4 py-2.5 shadow-card animate-[pop-in_160ms_ease-out]',
          className,
        )}
      >
        <FileSearch className="h-4 w-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium">{t('诊断报告第 {n} 版', { n: last.version })}</span>
          <span className="truncate text-xs text-warning">{t('确认方案后才会开始改')}</span>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          {t('查看报告')}
        </Button>
      </div>
      <DiagnosisDialog task={task} open={open} onOpenChange={setOpen} onDone={onDone} />
    </>
  )
}

/** 在别处（父对话页、对话里的报告行）打开某个子对话的报告：先取最新的一份再弹 */
export function DiagnosisLoader({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<Task | null>(null)
  useEffect(() => {
    let live = true
    api
      .task(taskId)
      .then((x) => live && setTask(x))
      .catch((e: Error) => {
        toast.error(e.message)
        onClose()
      })
    return () => {
      live = false
    }
    // 只按对话取一次：onClose 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])
  if (!task) return null
  return <DiagnosisDialog task={task} open onOpenChange={(v) => !v && onClose()} onDone={setTask} />
}

/**
 * 对话里的报告行：交了第几版、确认了、提了意见，都是一行可点开的记录，点开看那一版的报告（随时回看）。
 * 报告存在任务上（task.diagnoses），这一行只记版本号
 */
export function BugReportLine({ version, text, task }: { version: number; text: string; task: Task }) {
  const [open, setOpen] = useState(false)
  const d = task.diagnoses?.find((x) => x.version === version)
  return (
    <div className="flex items-center justify-center gap-1.5 text-footnote text-subtle">
      <FileSearch className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
      {d && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 cursor-pointer text-accent-text underline-offset-[3px] hover:underline"
        >
          {t('查看报告')}
        </button>
      )}
      {d && <DiagnosisDialog task={task} open={open} onOpenChange={setOpen} />}
    </div>
  )
}
