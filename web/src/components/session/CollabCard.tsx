import { useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { collabParty, type CollabEvent } from '@shared/collab-timeline'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/ui/modal'
import { SessionCard } from './SessionCard'

/** 会话栏里只列最近几条，其余点「全部」在弹窗里看 */
const SHOWN = 5
/** 父子对话一直在动时别每次推送都读一遍：两次读之间至少隔这么久 */
const MIN_GAP_MS = 5_000

/**
 * 会话栏的「协作」：父对话和子对话之间谁在什么时候给谁发了什么、是模型发的还是面板发的
 * （见 shared/collab-timeline.ts）。只在有父子关系的对话上出现；点子对话里的那条在右栏打开它
 */
export function CollabCard({
  task,
  kidsStamp,
  onOpenChild,
}: {
  task: Task
  /** 子对话列表变了（状态、数量）就重读 */
  kidsStamp: string
  onOpenChild?: (id: string) => void
}) {
  const [data, setData] = useState<{ rootId: string; events: CollabEvent[] } | null>(null)
  const [all, setAll] = useState(false)
  const last = useRef(0)
  const stamp = `${task.id}|${task.messages.length}|${kidsStamp}`
  useEffect(() => {
    let alive = true
    const wait = Math.max(0, last.current + MIN_GAP_MS - Date.now())
    const timer = setTimeout(() => {
      last.current = Date.now()
      api
        .taskCollab(task.id)
        .then((x) => alive && setData(x))
        .catch(() => alive && setData(null))
    }, wait)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // 按 stamp 重读：task 对象每秒都在变（执行中的推送），跟着它读太频繁
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])
  const events = data?.events ?? []
  const recent = events.slice(-SHOWN).reverse()
  const open = (x: CollabEvent) =>
    onOpenChild && x.taskId !== task.id && x.taskId !== data?.rootId ? () => onOpenChild(x.taskId) : undefined
  return (
    <SessionCard
      id="collab"
      title={t('协作')}
      trailing={
        events.length > SHOWN && (
          <button
            type="button"
            onClick={() => setAll(true)}
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sel hover:text-fg"
          >
            {t('全部 {n} 条', { n: events.length })}
          </button>
        )
      }
    >
      {!data ? (
        <p className="py-1 text-xs text-subtle">{t('读取中…')}</p>
      ) : !events.length ? (
        <p className="py-1 text-xs text-subtle">{t('父子对话之间还没有来往的消息')}</p>
      ) : (
        <ol className="flex flex-col" data-collab>
          {recent.map((x) => (
            <CollabRow key={x.id} x={x} rootId={data.rootId} onClick={open(x)} />
          ))}
        </ol>
      )}
      <Modal open={all} onOpenChange={setAll} title={t('父子协作时间线')} size="lg" closeOnOutside>
        <ol className="flex max-h-[70vh] flex-col overflow-y-auto overscroll-contain" data-collab-all>
          {[...events].reverse().map((x) => (
            <CollabRow
              key={x.id}
              x={x}
              rootId={data?.rootId ?? ''}
              wide
              onClick={
                open(x) &&
                (() => {
                  setAll(false)
                  open(x)!()
                })
              }
            />
          ))}
        </ol>
      </Modal>
    </SessionCard>
  )
}

const SOURCE_TONE = {
  model: 'bg-sel text-muted',
  panel: 'bg-accent-soft text-accent-text',
  user: 'bg-warning/15 text-warning',
} as const

function CollabRow({
  x,
  rootId,
  wide,
  onClick,
}: {
  x: CollabEvent
  rootId: string
  wide?: boolean
  onClick?: () => void
}) {
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
      <span className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-fg">
        <span
          className={cn('shrink-0 rounded px-1.5 py-px text-[0.6875rem] leading-4', SOURCE_TONE[x.source])}
          title={x.source === 'panel' ? t('面板发的') : x.source === 'user' ? t('你发的') : t('模型发的')}
        >
          {x.label}
        </span>
        <span className={cn('min-w-0', wide ? 'break-words' : 'truncate', x.failed && 'text-danger')} title={x.subject}>
          {x.subject}
        </span>
      </span>
    </>
  )
  const cls = cn('-mx-1 flex flex-col gap-0.5 rounded-md px-1 py-1.5', wide && 'mx-0 px-2')
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
