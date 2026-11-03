import { FileSearch } from 'lucide-react'
import type { Task, TaskRequest } from '@shared/schema'
import type { Diagnosis } from '@shared/bug-diagnosis-schema'
import { diagnosisMarkdown } from '@shared/bug-diagnosis'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
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

/** 每一版的标题、正文和状态：正文按上一版补出「回答上一版的意见」；author：引入点写不写作者（设置里的开关） */
function versionsOf(list: Diagnosis[], author: boolean) {
  return list.map((d, i) => ({
    key: String(d.version),
    label: t('第 {n} 版', { n: d.version }),
    detail: diagnosisMarkdown(d, list[i - 1], { author }),
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
  task: Pick<Task, 'id' | 'title' | 'diagnoses'>
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: (task: Task) => void
}) {
  const { settings } = useData()
  const author = settings?.bugAuthor !== false
  const list = task.diagnoses ?? []
  const last = list.at(-1)
  if (!last) return null
  const req: Pick<TaskRequest, 'id' | 'title' | 'detail'> = {
    id: `${task.id}:${last.version}`,
    title: t('诊断报告 · {title}', { title: task.title }),
    detail: diagnosisMarkdown(last, list.at(-2), { author }),
  }
  // 候选方案里没选的那几个：点一下加一条「改方案」意见，退回让它按这个方案交新一版（ADR 0046，档案不由界面直接改）
  const presets = last.options
    .filter((o) => o.id && o.id !== last.chosen?.id)
    .map((o) => ({
      label: t('改用方案 {id}', { id: o.id }),
      quote: t('方案 {id}：{title}', { id: o.id, title: o.title }),
      comment: t('改用这个方案'),
      kind: 'change',
    }))
  return (
    <ReviewDialog
      req={req}
      open={open}
      onOpenChange={onOpenChange}
      kinds={KINDS()}
      versions={versionsOf(list, author)}
      presets={presets}
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

/**
 * 对话里的一行记录：你确认了第几版、对第几版提了意见。「查看报告」只放在交报告的那一行工具调用上（用户 2026-11-03 定的），
 * 这里不再放入口，免得同一份报告到处都是按钮
 */
export function BugReportLine({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-footnote text-subtle">
      <FileSearch className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  )
}
