import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, CornerDownRight } from 'lucide-react'
import { t, uiLocale } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { peerKindText, subjectLine } from '@shared/peer-message'
import { timeAgo } from '@shared/task'
import type { Letter } from '@/lib/tasks'
import { useEscape } from '@/lib/useEscape'
import { cn } from '@/lib/utils'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { Markdown } from './Markdown'

/** 展开一个子对话时列几封：再早的是已经处理完的往来，要翻就去父子往来记录 */
const SHOWN = 6

/** 滚到对话流里那一封（收到的信行带 data-letter）：父对话的面板和子对话的「父对话」卡共用 */
export function scrollToLetter(id: string) {
  const el = document.querySelector(`[data-letter="${CSS.escape(id)}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return !!el
}

/**
 * 子对话面板里展开一个子对话：只列它和父对话之间的信（→ 交代任务、← 汇报……），没有状态行（ADR 0034）。
 * 收到的那几封点了滚到对话流里那一行；被新汇报取代的变淡
 */
export function ChildLetters({ letters }: { letters: Letter[] }) {
  const list = letters.slice(-SHOWN)
  if (!list.length) return <p className="py-1 pl-9 text-caption text-subtle">{t('还没有往来的信')}</p>
  return (
    <ul data-child-letters className="flex flex-col pb-1 pl-7">
      {list.map((x) => {
        const Dir = x.dir === 'in' ? ArrowLeft : ArrowRight
        const body = (
          <>
            <Dir className="h-3 w-3 shrink-0 text-subtle" aria-label={x.dir === 'in' ? t('收到') : t('发出')} />
            <span
              className={cn(
                'shrink-0 rounded-sm px-1 py-px text-caption leading-4',
                x.failed
                  ? 'bg-danger/12 text-danger'
                  : x.kind === 'question'
                    ? 'bg-warning/12 text-warning'
                    : 'bg-sel text-muted',
              )}
            >
              {peerKindText(x.kind)}
            </span>
            <span className="min-w-0 flex-1 truncate" title={x.subject}>
              {x.superseded ? t('（已被新的汇报取代）') : ''}
              {x.subject}
            </span>
            <span className="shrink-0 text-subtle tabular-nums" title={new Date(x.at).toLocaleString(uiLocale())}>
              {timeAgo(x.at)}
            </span>
          </>
        )
        const cls = cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-fg',
          x.superseded && 'opacity-55',
        )
        return (
          <li key={x.id} data-letter-item={x.dir}>
            {x.dir === 'in' ? (
              <button
                type="button"
                onClick={() => scrollToLetter(x.id)}
                title={t('在对话里找到这一封')}
                className={cn(cls, 'cursor-pointer hover:bg-sel')}
              >
                {body}
              </button>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 子对话这一侧的「父对话」：输入框上方一行，写父对话交代的任务；点开看任务原文和最新一次回答（ADR 0034）。
 * 只读子对话自己收到的信（peer.rel 为 parent），不另取数据
 */
export function ParentBar({ task, className }: { task: Task; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const { first, answer, name } = useMemo(() => {
    const got = task.messages.filter((m) => m.peer?.rel === 'parent')
    const tasks = got.filter((m) => m.peer!.kind === 'task')
    // 交代任务的原文：第一封（后来的补充交代在「最新回答」里看最后一封）
    const first = tasks[0] ?? got[0]
    const later = got.filter((m) => m !== first && (m.peer!.kind === 'answer' || m.peer!.kind === 'task'))
    return { first, answer: later.at(-1), name: first?.peer?.name || first?.peer?.title || '' }
  }, [task.messages])
  if (!first) return null
  const subject = first.peer?.subject || subjectLine(first.text)
  return (
    <div ref={ref} className={cn('relative', className)}>
      <div data-status-row="parent" className="flex min-w-0 items-center gap-2 px-2.5 text-body">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-muted transition-colors hover:bg-sel hover:text-fg"
        >
          <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <span className="shrink-0 font-medium">{t('父对话')}</span>
          <span className="min-w-0 truncate text-xs text-subtle" title={subject}>
            {t('交代任务')} · {subject}
          </span>
          <ChevronDown className={cn('h-3 w-3 shrink-0 text-subtle transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <ComposerPopover data-parent-card width="min(520px, calc(100% - 1.5rem))" className="max-h-[min(56vh,420px)]">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="text-body font-medium">{t('父对话')}</span>
            {name && <span className="min-w-0 truncate text-xs text-subtle">{name}</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-body">
            <Section title={t('交代的任务')} at={first.at} id={first.id} onPick={() => setOpen(false)}>
              <Markdown text={first.text} teamNames={new Set()} />
            </Section>
            {answer && (
              <Section
                title={answer.peer?.kind === 'answer' ? t('最新回答') : t('最新交代')}
                at={answer.at}
                id={answer.id}
                onPick={() => setOpen(false)}
              >
                <Markdown text={answer.text} teamNames={new Set()} />
              </Section>
            )}
          </div>
        </ComposerPopover>
      )}
    </div>
  )
}

function Section({
  title,
  at,
  id,
  onPick,
  children,
}: {
  title: string
  at: string
  id: string
  onPick: () => void
  children: React.ReactNode
}) {
  return (
    <section className="border-b pb-2 last:border-b-0 [&+&]:pt-2">
      <h3 className="mb-1 flex items-center gap-2 text-footnote font-normal text-subtle">
        {title}
        <span className="tabular-nums">{timeAgo(at)}</span>
        <button
          type="button"
          onClick={() => scrollToLetter(id) && onPick()}
          className="ml-auto cursor-pointer rounded-sm px-1 text-caption hover:bg-sel hover:text-fg"
        >
          {t('在对话里看')}
        </button>
      </h3>
      {children}
    </section>
  )
}
