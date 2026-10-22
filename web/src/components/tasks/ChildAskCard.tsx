import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, MessageCircleQuestion, SendHorizontal } from 'lucide-react'
import type { Task, TaskMessage } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { t } from '@shared/i18n'
import { Markdown } from './Markdown'
import { RowShell } from './ToolRow'
import { useChildOpen } from './child-open'

/**
 * 子对话请父对话决定的问题：放在父对话的消息流里，和工具条目一个样式。
 * 没回答时展开着：可以点子对话给的选项、自己写决定，或者交给父对话的 AI 决定；
 * 回答后（你在这里答的，或父对话把决定交给了那个子对话）收成一行，点开能看问题和决定。
 * 不用弹窗：几个子对话同时问时各自留在发生的位置，也不挡住父对话的输入框
 */
export function ChildAskCard({ m, task, teamNames }: { m: TaskMessage; task?: Task; teamNames: Set<string> }) {
  const ask = m.ask!
  const answered = ask.answer !== undefined
  const [open, setOpen] = useState(!answered)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'' | 'send' | 'delegate' | number>('')
  const [delegated, setDelegated] = useState(false)
  const openChild = useChildOpen()
  // 回答后自动收起；之后用户自己点开、收起都随意
  const [wasAnswered, setWasAnswered] = useState(answered)
  if (answered !== wasAnswered) {
    setWasAnswered(answered)
    if (answered) setOpen(false)
  }

  const send = async (key: typeof busy, answer: string, delegate = false) => {
    if (!task || busy) return
    setBusy(key)
    try {
      await api.answerChildAsk(task.id, m.id, { answer, delegate })
      if (delegate) setDelegated(true)
      else setText('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const status = answered ? (
    <span className="shrink-0 font-sans text-subtle">{ask.by === 'user' ? t('你已决定') : t('父对话已决定')}</span>
  ) : delegated ? (
    <span className="shrink-0 font-sans text-subtle">{t('交给父对话决定')}</span>
  ) : (
    <span className="shrink-0 rounded-full bg-warning/15 px-1.5 font-sans text-[0.6875rem] leading-[1.125rem] text-warning">
      {t('待决定')}
    </span>
  )

  return (
    <RowShell
      glyph={
        <MessageCircleQuestion className={cn('h-3.5 w-3.5 shrink-0', answered ? 'text-subtle' : 'text-warning')} />
      }
      verb={t('子对话请你决定')}
      title={ask.title}
      onOpen={openChild ? () => openChild(ask.from) : undefined}
      openTip={t('在右侧打开子对话')}
      detail={status}
      open={open}
      onToggle={() => setOpen(!open)}
      className={cn(!answered && 'border-warning/35')}
    >
      <div className="flex flex-col gap-2.5 border-t bg-card/60 px-3 py-2.5">
        <div className="max-h-[min(40vh,320px)] overflow-y-auto text-[0.8125rem]">
          <Markdown text={ask.question} teamNames={teamNames} />
        </div>
        {answered ? (
          <div className="flex gap-2 rounded-lg bg-field px-2.5 py-2 text-[0.8125rem]">
            <span className="shrink-0 text-subtle">{t('决定')}</span>
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{ask.answer}</span>
          </div>
        ) : (
          <>
            {ask.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {ask.options.map((o, i) => (
                  <button
                    key={i}
                    type="button"
                    disabled={!!busy}
                    onClick={() => send(i, o)}
                    className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border border-line px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors hover:border-line-strong hover:bg-sel disabled:cursor-default disabled:opacity-60"
                  >
                    <span className="mt-px grid h-[1.125rem] w-[1.125rem] shrink-0 place-items-center rounded bg-sel font-mono text-[0.6875rem] text-muted">
                      {busy === i ? <Loader2 className="h-3 w-3 animate-spin" /> : i + 1}
                    </span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-lg border border-line bg-field px-2.5 py-1.5 focus-within:border-line-strong">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && text.trim()) {
                    e.preventDefault()
                    void send('send', text.trim())
                  }
                }}
                rows={1}
                placeholder={ask.options.length ? t('都不合适？写下你的决定…') : t('写下你的决定…')}
                aria-label={t('你的决定')}
                className="max-h-32 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0.5 text-[0.8125rem] leading-relaxed outline-none [field-sizing:content] placeholder:text-subtle"
              />
              <button
                type="button"
                disabled={!text.trim() || !!busy}
                onClick={() => send('send', text.trim())}
                aria-label={t('交给子对话')}
                title={t('交给子对话')}
                className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-accent hover:bg-accent/10 disabled:cursor-default disabled:text-subtle disabled:hover:bg-transparent"
              >
                {busy === 'send' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SendHorizontal className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-xs text-subtle">
                {delegated ? t('父对话会处理这个问题，决定后交给子对话') : t('你的决定会直接交给子对话')}
              </span>
              {!delegated && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => send('delegate', '', true)}
                  className="h-7 text-xs"
                >
                  {busy === 'delegate' && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('交给父对话决定')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </RowShell>
  )
}
