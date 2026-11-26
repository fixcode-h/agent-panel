import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { ruleText } from '@shared/allow-rules'
import { GRANT_SOURCES } from '@shared/grants/sources'
import { t } from '@shared/i18n'
import type { Task, TaskMessage } from '@shared/schema'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { RevokeButton } from '@/components/ui/grant-badge'
import { fmtClock } from '@/lib/tasks'
import { useEscape } from '@/lib/useEscape'
import { cn } from '@/lib/utils'

/** 浮层里最近几条自动允许 */
const RECENT = 8

const autoNotes = (task: Pick<Task, 'messages'>) =>
  task.messages.filter((m) => m.role === 'system' && m.grant && m.grant.via !== 'user')

/** 这条规则给人看的说法：对话里点「本对话不再询问」那一行记的，没有就按键名写 */
function ruleName(task: Pick<Task, 'messages'>, rule: string) {
  const from = task.messages.find((m) => m.grant?.rule === rule && m.grant.label)
  return from?.grant?.label || ruleText(rule)
}

/** 有放行规则、或者面板替你放行过时才显示 */
export const hasGrants = (task: Pick<Task, 'messages' | 'allowRules'>) =>
  (task.allowRules?.length ?? 0) > 0 || autoNotes(task).length > 0

/**
 * 输入框上方状态行里的「放行规则」（用户 2026-11-26 选的方案 A 的总入口）：这个对话记下了哪些放行规则、各自自动允许了几次，
 * 能逐条撤销；下面是最近面板替你放行的几次。对话里每次放行只在工具卡片上标一个小标，这里看全貌
 */
export function GrantRulesButton({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscape(open, () => setOpen(false))
  // 点外面关：和待办、计划窗口一样
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  if (!hasGrants(task)) return null
  const rules = task.allowRules ?? []
  const notes = autoNotes(task)
  const count = (rule: string) => notes.filter((m) => m.grant?.rule === rule).length
  const others = notes.filter((m) => !m.grant?.rule || !rules.includes(m.grant.rule))
  return (
    <div ref={ref} className="relative flex min-w-0 shrink items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('放行规则')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-body text-muted transition-colors hover:bg-sel hover:text-fg',
          open && 'bg-sel text-fg',
        )}
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
        <span className="shrink-0 font-medium">{t('放行规则 {n} 条', { n: rules.length })}</span>
        {notes.length > 0 && (
          <span className="shrink-0 text-xs text-subtle">{t('· 自动允许 {n} 次', { n: notes.length })}</span>
        )}
      </button>
      {open && (
        <ComposerPopover
          role="dialog"
          aria-label={t('放行规则')}
          width="min(520px, calc(100vw - 2rem))"
          className="max-h-[min(64vh,560px)]"
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-4 pt-3.5 pb-3">
            <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
            <span className="text-body font-medium">{t('这个对话的放行规则')}</span>
            <span className="ml-auto text-caption text-subtle">{t('撤销后同一类调用会重新问你')}</span>
          </div>
          <div className="flex min-h-0 flex-col overflow-y-auto py-2">
            {rules.length === 0 && (
              <span className="px-4 py-1 text-caption text-subtle">
                {t('还没有记下规则：授权卡上点「本对话不再询问」才会记')}
              </span>
            )}
            {rules.map((r) => (
              <div key={r} data-grant-rule={r} className="flex min-h-8 min-w-0 items-center gap-2 px-4">
                <span className="min-w-0 flex-1 truncate text-footnote text-fg" title={r}>
                  {ruleName(task, r)}
                </span>
                <span className="shrink-0 text-caption text-subtle tabular-nums">{t('{n} 次', { n: count(r) })}</span>
                <RevokeButton task={task} rule={r} label={t('撤销')} />
              </div>
            ))}
            {notes.length > 0 && (
              <>
                <div className="mx-4 my-1.5 border-t border-line" />
                <span className="px-4 pb-1 text-caption text-subtle">{t('最近自动允许的')}</span>
                {notes
                  .slice(-RECENT)
                  .reverse()
                  .map((m) => (
                    <RecentRow key={m.id} m={m} />
                  ))}
              </>
            )}
            {others.length > 0 && (
              <span className="px-4 pt-1.5 text-caption text-subtle">
                {t('只读命令、测试步骤这类是面板默认放行的，不用记规则')}
              </span>
            )}
          </div>
        </ComposerPopover>
      )}
    </div>
  )
}

function RecentRow({ m }: { m: TaskMessage }) {
  const g = m.grant!
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-2 px-4 text-caption" title={g.title || m.text}>
      <span className="w-16 shrink-0 text-subtle tabular-nums">{fmtClock(m.at)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted">{g.title || m.text}</span>
      <span className="shrink-0 text-subtle">{GRANT_SOURCES[g.via].badge()}</span>
    </div>
  )
}
