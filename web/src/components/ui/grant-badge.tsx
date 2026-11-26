import { useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, ShieldX, Undo2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { GRANT_SOURCES } from '@shared/grants/sources'
import { t } from '@shared/i18n'
import type { Task, TaskMessage, ToolGrant } from '@shared/schema'
import { tasksContract } from '@shared/api-contract/tasks'
import { call } from '@/lib/api/call'
import { useTaskApply } from '@/components/tasks/task-apply'
import { fmtClock } from '@/lib/tasks'
import { cn } from '@/lib/utils'

/**
 * 对话里「面板替你放行」的几种显示（用户 2026-11-26 选的方案 A，效果图 designs/对话授权提示重设计-效果图/）：
 * - GrantBadge：工具卡片耗时旁的小标（和路由小标同一种写法），自动允许的不再单独占一行；
 * - GrantSection：点开工具卡片时最上面一段，按哪条规则、规则怎么来的、完整命令、撤销；
 * - GrantRunRow：挂不到卡片上的放行记录（CLI 没报工具行、旧版本记的），同一规则连续的合成一行，点开逐条看；
 * - DecisionLine：你自己在授权卡上点的允许 / 拒绝，和工具卡片对齐的一行。
 * 来源的说法都在 shared/grants/sources.ts；设置 → 组件微调「放行小标」能关掉小标、只留图标、改合并行默认展开
 */

/** 能撤销放行规则要的那点对话信息（工具行、合并行拿到的 task 可能只是一部分） */
export type GrantTask = Partial<Pick<Task, 'id' | 'messages' | 'allowRules' | 'imported'>>

/** 规则的说法：浅底小块 */
export function RuleChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="chip-lift inline-flex max-w-60 shrink-0 items-center truncate rounded-sm bg-sel px-1.5 text-caption leading-5 text-muted">
      {children}
    </span>
  )
}

/** 工具卡片耗时旁的小标：「· 🛡 规则放行」 */
export function GrantBadge({ grant, className }: { grant: ToolGrant; className?: string }) {
  const src = GRANT_SOURCES[grant.via]
  return (
    <span
      data-grant-badge=""
      title={src.long(grant.label) + (grant.label && grant.via === 'rule' ? `（${grant.label}）` : '')}
      className={cn(
        'min-w-0 shrink items-center gap-1 text-caption text-subtle [display:var(--c-grantBadge-show)]',
        className,
      )}
    >
      <span aria-hidden className="text-subtle/60">
        ·
      </span>
      <ShieldCheck className="h-3 w-3 shrink-0 text-success" />
      <span className="min-w-0 truncate [display:var(--c-grantBadge-text)]">{src.badge()}</span>
    </span>
  )
}

/** 这条规则是什么时候、怎么记下的：对话里用户点「本对话不再询问」的那一行 */
function ruleOrigin(task: GrantTask, rule?: string) {
  if (!rule) return undefined
  return task.messages?.find((m) => m.grant?.via === 'user' && m.grant.always && m.grant.rule === rule)
}

/** 撤销这条规则：之后同一类调用重新弹卡 */
function useRevoke(task: GrantTask, rule?: string) {
  const [busy, setBusy] = useState(false)
  const apply = useTaskApply()
  const can = !!task.id && !task.imported && !!rule && (task.allowRules ?? []).includes(rule)
  const revoke = async () => {
    if (!task.id || !rule) return
    setBusy(true)
    try {
      const saved = await call(tasksContract.revokeRule, { params: { id: task.id }, body: { revokeRule: rule } })
      apply?.(saved)
      toast.success(t('已撤销，之后这类调用会重新问你'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { can, busy, revoke }
}

export function RevokeButton({ task, rule, label }: { task: GrantTask; rule?: string; label?: string }) {
  const r = useRevoke(task, rule)
  if (!r.can) return null
  return (
    <button
      type="button"
      disabled={r.busy}
      onClick={(e) => {
        e.stopPropagation()
        void r.revoke()
      }}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-muted transition-colors hover:bg-sel hover:text-fg disabled:opacity-50"
    >
      <Undo2 className="h-3 w-3" />
      {label ?? t('撤销这条规则')}
    </button>
  )
}

/** 点开工具卡片时最上面的一段：怎么被放行的、规则从哪来、实际放行的命令 */
export function GrantSection({ grant, task }: { grant: ToolGrant; task: GrantTask }) {
  const note = task.messages?.find((m) => m.id === grant.note)
  const g = note?.grant
  const src = GRANT_SOURCES[grant.via]
  const origin = ruleOrigin(task, g?.rule)
  return (
    <div data-grant-section="" className="flex flex-col gap-1 px-3 py-2 font-sans text-caption">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-subtle">
        <ShieldCheck className="h-3 w-3 shrink-0 text-success" />
        <span>{src.long(grant.label)}</span>
        {grant.via === 'rule' && grant.label && <RuleChip>{grant.label}</RuleChip>}
        {origin && <span>{t('· {time} 你点的「本对话不再询问」', { time: fmtClock(origin.at) })}</span>}
        <span className="flex-1" />
        {src.revocable && <RevokeButton task={task} rule={g?.rule} />}
      </span>
      {g?.title && (
        <span className="flex min-w-0 items-start gap-2 pl-4.5 text-subtle">
          <span className="shrink-0">{t('放行的是')}</span>
          <span className="min-w-0 font-mono text-muted [overflow-wrap:anywhere]">{g.title}</span>
        </span>
      )}
    </div>
  )
}

/** 挂不到卡片上的放行记录：同一规则连续的几次合成一行，点开逐条看（悬停看完整命令） */
export function GrantRunRow({ run, task, open: initial }: { run: TaskMessage[]; task: GrantTask; open?: boolean }) {
  const [open, setOpen] = useState(!!initial)
  const g = run[0].grant!
  const src = GRANT_SOURCES[g.via]
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div data-grant-run="" className="min-w-0 rounded-(--c-row-radius) bg-(--c-row-bg)">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--c-row-radius) py-1 pr-1 pl-2 text-left text-footnote text-muted transition-colors hover:bg-fg/[0.04]"
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
        <span className="shrink-0 text-fg">
          {run.length > 1 ? t('自动允许 {n} 次', { n: run.length }) : t('自动允许')}
        </span>
        {g.label && g.via !== 'mode' && <RuleChip>{g.label}</RuleChip>}
        <span className="min-w-0 truncate text-subtle">{src.long(g.label)}</span>
        <span className="flex-1" />
        <Chevron className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </button>
      {open && (
        <div className="flex flex-col border-t border-line py-1 text-caption">
          {run.map((m) => (
            <div key={m.id} className="flex min-h-6 min-w-0 items-center gap-2 px-3" title={m.grant?.title || m.text}>
              <span className="w-16 shrink-0 text-subtle tabular-nums">{fmtClock(m.at)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted">{m.grant?.title || m.text}</span>
            </div>
          ))}
          {src.revocable && (
            <div className="flex items-center px-2 pt-1">
              <RevokeButton task={task} rule={g.rule} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 你自己在授权卡上点的允许 / 拒绝：和工具卡片对齐的一行，选了「本对话不再询问」的后面标出规则、能撤销 */
export function DecisionLine({ m, task }: { m: TaskMessage; task: GrantTask }) {
  const g = m.grant!
  const Icon = g.denied ? ShieldX : ShieldCheck
  return (
    <div
      data-grant-decision=""
      title={m.text}
      className="flex min-h-7 min-w-0 items-center gap-2 py-1 pr-1 pl-2 text-footnote"
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', g.denied ? 'text-danger' : 'text-success')} />
      <span className="shrink-0 text-fg">{g.denied ? t('你拒绝了') : t('你允许了')}</span>
      {/* 请求标题多是问句（「运行自建工具「x」？」）：记成结果时去掉问号 */}
      <span className="min-w-0 truncate text-muted">{g.title.replace(/[？?]\s*$/, '')}</span>
      {g.always && <RuleChip>{t('本对话不再询问')}</RuleChip>}
      <span className="flex-1" />
      {g.always && <RevokeButton task={task} rule={g.rule} label={t('撤销')} />}
    </div>
  )
}
