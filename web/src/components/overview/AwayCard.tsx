import { useEffect, useState } from 'react'
import { Coffee, X } from 'lucide-react'
import { awayRedoDraft, type AwayPick, type AwayState } from '@shared/away'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/task'
import { awayApi } from '@/lib/api-away'
import { useNav, useTasks } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'

/** 对话输入框的草稿键：和 TaskView 里 ChatComposer 的 draftKey、useDraft 的前缀一致 */
const draftKeyOf = (taskId: string) => `chat-draft:task:${taskId}`

/**
 * 「我不在」的状态：总览页和首页都要用。对话列表一变就重新取（自动选了一条会带动那个对话变），
 * 取失败报出来，不悄悄当成没开
 */
export function useAway() {
  const { tasks } = useTasks()
  const [state, setState] = useState<AwayState>()
  useEffect(() => {
    let alive = true
    awayApi
      .get()
      .then((s) => alive && setState(s))
      .catch((e) => alive && toast.error((e as Error).message))
    return () => {
      alive = false
    }
  }, [tasks])
  return [state, setState] as const
}

const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

/**
 * 总览页顶上的「我不在」：开关 + 说明，下面列出开着时面板替你选过的（分析稿 A4）。
 * 「去改」回到那个对话，输入框里先填好一句「我改成：」，接着写就能发
 */
export function AwayCard() {
  const [state, setState] = useAway()
  const { go } = useNav()
  const [busy, setBusy] = useState(false)
  const on = !!state?.on
  const picks = state?.picks ?? []

  const run = async (fn: () => Promise<AwayState>) => {
    setBusy(true)
    try {
      setState(await fn())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const redo = (p: AwayPick) => {
    // 输入框里已经有没发的话就不盖掉：用户的草稿比这句提示要紧
    try {
      if (!localStorage.getItem(draftKeyOf(p.taskId))) localStorage.setItem(draftKeyOf(p.taskId), awayRedoDraft(p))
    } catch {}
    go(p.projectId ? { page: 'projects', id: p.projectId, sub: p.taskId } : { page: 'chat', id: p.taskId })
  }

  return (
    <Card as="section" aria-label={t('我不在')} data-away className={cn('py-1.5', on && 'bg-accent-soft/60')}>
      <div className="flex items-start gap-3 px-4 py-2.5">
        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
            on ? 'bg-accent-soft text-accent-text' : 'bg-sel text-muted',
          )}
        >
          <Coffee className="h-[18px] w-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor="away-switch" className="flex items-center gap-2 text-body font-medium text-fg">
            {t('我不在')}
            {on && (
              <span className="text-xs font-normal text-accent-text" data-away-since>
                {t('{time} 起开着', { time: clock(state?.since ?? '') })}
              </span>
            )}
          </label>
          <p className="text-xs text-muted">
            {t(
              '开着时，能反悔的选择题按 Agent 推荐的选项自动选，对话里留一行、回来能改；不可逆的操作、诊断报告确认、要你去操作的事照旧等你。',
            )}
          </p>
        </div>
        <Switch
          id="away-switch"
          className="mt-1.5"
          checked={on}
          disabled={!state || busy}
          onCheckedChange={(v) => void run(() => awayApi.set(v))}
        />
      </div>
      {picks.length > 0 && (
        <div className="border-t border-line/70 px-1.5 pt-1.5" data-away-picks>
          <header className="flex items-center gap-2 px-2.5 pb-1">
            <h3 className="text-xs font-medium text-muted">{t('自动选过的 {n} 项', { n: picks.length })}</h3>
            <Button
              variant="link"
              tone="muted"
              className="ml-auto text-xs"
              disabled={busy}
              onClick={() => void run(() => awayApi.drop())}
            >
              {t('全部知道了')}
            </Button>
          </header>
          <ul className="flex flex-col gap-0.5">
            {picks.map((p) => (
              <li
                key={p.id}
                className="group flex items-center gap-x-3 gap-y-1.5 rounded-lg px-2.5 py-2 hover:bg-sel/60 max-sm:flex-wrap"
                data-away-pick={p.id}
              >
                {/* 手机宽度下问题和选了什么占满一行，按钮换到下一行靠右，不把文字挤成半截 */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 max-sm:basis-full">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-prose text-fg">{p.taskTitle || t('对话')}</span>
                    <span className="shrink-0 text-xs text-subtle tabular-nums">{timeAgo(p.at)}</span>
                  </span>
                  {p.items.map((x, i) => (
                    <span key={i} className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted">
                      <span className="min-w-0 truncate">{x.question}</span>
                      <span className="shrink-0 text-subtle">→</span>
                      <span className="max-w-[45%] shrink-0 truncate font-medium text-fg">{x.picked}</span>
                    </span>
                  ))}
                </div>
                <Button size="sm" variant="secondary" className="max-sm:ml-auto" onClick={() => redo(p)}>
                  {t('去改')}
                </Button>
                <IconButton
                  icon={X}
                  size="xs"
                  label={t('知道了')}
                  disabled={busy}
                  onClick={() => void run(() => awayApi.drop(p.id))}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
