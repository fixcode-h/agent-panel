import { useState } from 'react'
import { toast } from '@/lib/toast'
import { ArrowUpRight, Lightbulb, Loader2, MessageCircleQuestion } from 'lucide-react'
import type { Task, TaskMessage } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { QuestionPanel } from '@/components/chat/QuestionPanel'
import { t } from '@shared/i18n'
import { Markdown } from './Markdown'
import { RowShell } from './ToolRow'
import { useChildOpen } from './child-open'

/**
 * 子对话请用户决定的事（执行中的提问、这一轮做完的收尾建议），在父对话消息流里的那一条：
 * 只做提醒，选择在子对话的输入框处弹出。
 * 没回答时醒目地展开着，「去选择」在右栏打开那个子对话；也可以直接交给父对话的 AI 决定。
 * 回答后（在子对话里选的，或父对话把决定交给了那个子对话）收成一行，点开能看问题和决定。
 * 几个子对话同时问时各自留在发生的位置，不挡住父对话的输入框
 */
export function ChildAskCard({ m, task, teamNames }: { m: TaskMessage; task?: Task; teamNames: Set<string> }) {
  const ask = m.ask!
  // 收尾建议是这一轮做完了在问下一步怎么做，说法和「提问」不一样：别让用户以为它还在等一个问题
  const suggestion = ask.kind === 'suggestion'
  const answered = ask.answer !== undefined
  const [busy, setBusy] = useState(false)
  // 点了「交给父对话决定」：接口返回前就换成已交出，刷新后由 ask.delegated 记着
  const [handed, setHanded] = useState(false)
  // 没能叫起父对话的原因：服务端写在卡片上（刷新后还在），本次点击失败时也用它
  const [failed, setFailed] = useState('')
  const delegated = !answered && (ask.delegated || handed)
  const pending = !answered && !delegated
  const nudgeError = delegated ? (ask.delegatedError ?? failed) : ''
  // 没叫起父对话时保持展开：原因和重试要一眼能看到，不能收在折叠区里
  const expanded = pending || !!nudgeError
  const [open, setOpen] = useState(expanded)
  const openChild = useChildOpen()
  // 状态变了（回答了、交出去了、叫不起来了）跟着展开或收起；之后用户自己点开、收起都随意
  const [wasExpanded, setWasExpanded] = useState(expanded)
  if (expanded !== wasExpanded) {
    setWasExpanded(expanded)
    setOpen(expanded)
  }

  const delegate = async () => {
    if (!task || busy) return
    setBusy(true)
    try {
      const r = await api.answerChildAsk(task.id, m.id, { answer: '', delegate: true })
      setHanded(true)
      // 接口成功不代表叫起了父对话：没叫起来时把原因留在卡片上，并给重试
      setFailed(r.nudge && !r.nudge.ok ? r.nudge.error : '')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 父对话的「提问」关着（用户去掉了提问入口）：没人会回答，未回答的提问不该再显示成卡片
  // 或「交给父对话决定」的折叠行。服务端已经不再产生这种卡片，这里收掉历史遗留的；回答过的仍显示，是对话记录
  if (task && !task.askUser && !answered) return null

  const status = answered ? (
    <span className="shrink-0 font-sans text-subtle">
      {ask.declined ? t('你没回答，子对话已终止') : ask.by === 'user' ? t('你已决定') : t('父对话已决定')}
    </span>
  ) : delegated ? (
    <span className={cn('shrink-0 font-sans', nudgeError ? 'text-destructive' : 'text-subtle')}>
      {nudgeError ? t('没能叫起父对话') : t('已交给父对话决定')}
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning/15 px-1.5 font-sans text-[0.6875rem] leading-[1.125rem] text-warning">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inset-0 animate-ping rounded-full bg-warning/60" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-warning" />
      </span>
      {t('等你选择')}
    </span>
  )

  return (
    <RowShell
      glyph={
        suggestion ? (
          <Lightbulb className={cn('h-3.5 w-3.5 shrink-0', pending ? 'text-warning' : 'text-subtle')} />
        ) : (
          <MessageCircleQuestion className={cn('h-3.5 w-3.5 shrink-0', pending ? 'text-warning' : 'text-subtle')} />
        )
      }
      verb={
        pending
          ? suggestion
            ? t('子对话的收尾建议，请你决定下一步')
            : t('子对话请你选择')
          : suggestion
            ? t('子对话的收尾建议')
            : t('子对话请你决定')
      }
      title={ask.title}
      onOpen={openChild ? () => openChild(ask.from) : undefined}
      openTip={t('在右栏打开子对话')}
      detail={status}
      open={open}
      onToggle={() => setOpen(!open)}
      // 等你选择时和「转交提问」一样只描一圈琥珀色，不填底（组件库「对话之间」）
      // 等你选择时是要处理的一块：保留卡片外框（琥珀色），处理完和别的过程行一样不画框
      boxed={pending}
      className={cn(pending && 'border-warning/45')}
    >
      <div className={cn('flex flex-col gap-2.5 border-t px-3 py-2.5', pending ? 'border-warning/25' : 'bg-card/60')}>
        <div
          className={cn(
            'text-[0.8125rem]',
            // 等选择时只露个开头，完整的问题在子对话的选择弹窗里看
            pending
              ? 'max-h-[4.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]'
              : 'max-h-[min(40vh,320px)] overflow-y-auto',
          )}
        >
          <Markdown text={ask.question} teamNames={teamNames} />
        </div>
        {answered ? (
          <div className="flex gap-2 rounded-lg bg-field px-2.5 py-2 text-[0.8125rem]">
            <span className="shrink-0 text-subtle">{t('决定')}</span>
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{ask.answer}</span>
          </div>
        ) : delegated ? (
          nudgeError ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-[0.8125rem] text-destructive">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {t('没能叫起父对话：{error}', { error: nudgeError })}
              </span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void delegate()} className="h-7 text-xs">
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                {t('重试')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-subtle">{t('已交给父对话决定，它会在下一轮处理')}</p>
          )
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-xs text-subtle">
              {ask.options.length
                ? t('有 {n} 个可选做法，在子对话里选', { n: ask.options.length })
                : t('在子对话里回答')}
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void delegate()} className="h-7 text-xs">
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {t('交给父对话决定')}
            </Button>
            {openChild && (
              <Button size="sm" onClick={() => openChild(ask.from)} className="h-7 text-xs">
                {t('去选择')}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </RowShell>
  )
}

/**
 * 子对话自己的输入框处：它请用户决定、还没人回答的提问，复用 Agent 提问的选择弹窗。
 * 几个提问一起问时一题一页，全部选完一起交回；选择直接交给子对话，父对话的 AI 也会知道。
 * 右上角的关闭：这些提问都不回答，子对话终止
 */
export function ParentAskPanel({ task, onClosed }: { task: Task; onClosed: (t: Task) => void }) {
  const asks = task.parentAsks ?? []
  const parentId = task.parentTaskId
  if (!asks.length || !parentId) return null
  const suggesting = asks.every((a) => a.kind === 'suggestion')
  const answerAll = async (answers: string[], delegate: boolean) => {
    try {
      // 一个个交：前面的已经交给子对话了，后面的出错时只报错，不回滚
      for (const [i, a] of asks.entries()) {
        const r = await api.answerChildAsk(parentId, a.id, { answer: delegate ? '' : (answers[i] ?? ''), delegate })
        // 交给父对话决定时没叫起来：明确告诉用户，不要当成成功
        if (r.nudge && !r.nudge.ok) toast.error(t('没能叫起父对话：{error}', { error: r.nudge.error }))
      }
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <QuestionPanel
      className="mb-2"
      // 收尾建议和提问共用这套弹窗：只有说法不同，用户选完都是同一个结果（直接交给子对话）
      label={suggesting ? t('下一步怎么做') : t('需要你选择')}
      who={
        <span className="truncate">
          {suggesting ? t('子对话给出了下一步的建议，选一下就按它继续') : t('子对话请你决定，选择会直接交给它')}
        </span>
      }
      questions={asks.map((a, i) => ({
        header: asks.length > 1 ? t('问题 {n}', { n: i + 1 }) : undefined,
        question: a.question,
        options: a.options.map((label) => ({ label })),
      }))}
      onSubmit={(answers) => answerAll(answers, false)}
      onSkip={() => answerAll([], true)}
      skipLabel={t('交给父对话决定')}
      onClose={async () => {
        try {
          onClosed(await api.closeParentAsks(task.id))
        } catch (e) {
          toast.error((e as Error).message)
        }
      }}
      closeLabel={t('不回答，终止子对话')}
    />
  )
}
