import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { collabParty, type CollabEvent } from '@shared/collab-timeline'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/ui/modal'

/**
 * 「父子往来记录」：父对话和名下子对话之间谁在什么时候给谁发了什么、是模型发的还是面板发的
 * （见 shared/collab-timeline.ts）。含面板推它接着做、你直接说的话和来源标签，是排查用的完整时间线，
 * 从对话菜单打开，默认不出现在右栏（ADR 0034：右栏不再列子对话，信件在输入框上方的子对话面板里看）
 */
export function CollabLog({
  taskId,
  onClose,
  onOpenChild,
}: {
  taskId: string
  onClose: () => void
  onOpenChild?: (id: string) => void
}) {
  const [data, setData] = useState<{ rootId: string; events: CollabEvent[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api
      .taskCollab(taskId)
      .then((x) => alive && setData(x))
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [taskId])
  const events = data?.events ?? []
  const open = (x: CollabEvent) =>
    onOpenChild && x.taskId !== taskId && x.taskId !== data?.rootId
      ? () => {
          onClose()
          onOpenChild(x.taskId)
        }
      : undefined
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('父子往来记录')} size="lg" closeOnOutside>
      {error ? (
        <p className="py-2 text-xs text-danger">{error}</p>
      ) : !data ? (
        <p className="py-2 text-xs text-subtle">{t('读取中…')}</p>
      ) : !events.length ? (
        <p className="py-2 text-xs text-subtle">{t('父子对话之间还没有来往的消息')}</p>
      ) : (
        <ol className="flex max-h-[70vh] flex-col overflow-y-auto overscroll-contain" data-collab-all>
          {[...events].reverse().map((x) => (
            <CollabRow key={x.id} x={x} rootId={data.rootId} onClick={open(x)} />
          ))}
        </ol>
      )}
    </Modal>
  )
}

const SOURCE_TONE = {
  model: 'bg-sel text-muted',
  panel: 'bg-accent-soft text-accent-text',
  user: 'bg-warning/15 text-warning',
} as const

function CollabRow({ x, rootId, onClick }: { x: CollabEvent; rootId: string; onClick?: () => void }) {
  const from = collabParty(x.from, rootId, x.source)
  const to = collabParty(x.to, rootId, 'model')
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
        <span className="min-w-0 truncate">{from}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-subtle" />
        <span className="min-w-0 truncate">{to}</span>
        <span className="ml-auto shrink-0 pl-2 text-subtle tabular-nums" title={new Date(x.at).toLocaleString()}>
          {timeAgo(x.at)}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-body text-fg">
        <span
          className={cn('shrink-0 rounded-sm px-1.5 py-px text-caption leading-4', SOURCE_TONE[x.source])}
          title={x.source === 'panel' ? t('面板发的') : x.source === 'user' ? t('你发的') : t('模型发的')}
        >
          {x.label}
        </span>
        <span className={cn('min-w-0', 'break-words', x.failed && 'text-danger')} title={x.subject}>
          {x.subject}
        </span>
      </span>
    </>
  )
  const cls = 'flex flex-col gap-0.5 rounded-md px-2 py-1.5'
  return (
    <li>
      {onClick ? (
        <button type="button" onClick={onClick} className={cn(cls, 'w-full cursor-pointer text-left hover:bg-sel')}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  )
}
