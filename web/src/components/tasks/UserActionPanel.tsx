/**
 * 等你操作（request_user_action）：Agent 请用户离开对话去做一件事，做完交回结果再接着做。
 * 面板停靠在输入框正上方（和提问面板同一个位置、同一套琥珀底），能收起成一行转圈；
 * 输入框就是交回框：挂着「交回给」标签时发送就算交回（见 handBackFor），面板上只留「完成了」「做不了」「跳过」。
 * 设计见 docs/openspec/changes/user-action-wait/design.md
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronUp, Hand, Loader2, X } from 'lucide-react'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { pendingAction, waitedText, type UserAction } from '@shared/user-action'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/status-pill'

// 用户点掉了「交回给」标签的那几件、收起了面板的那几件：只是这个页面里的显示偏好，不存服务端
const detached = new Set<string>()
const folded = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => {
  version++
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const useStoreVersion = () => useSyncExternalStore(subscribe, () => version)

/** 发送时要交回的那件事的 id：有在等的、用户也没点掉「交回给」时才有 */
export function handBackFor(task: Pick<Task, 'userActions'>): string {
  const a = pendingAction(task)
  return a && !detached.has(a.id) ? a.id : ''
}

/** 输入框要不要画成交回的样子（提醒色边框、「交回给」标签）：跟着点掉 / 挂回刷新 */
export function useHandBack(task: Pick<Task, 'userActions'>): string {
  useStoreVersion()
  return handBackFor(task)
}

/** 等了多久每半分钟刷新一次：面板上写着「已等 12 分钟」，不能一直停在打开时的数 */
function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => set((x) => x + 1), 30_000)
    return () => clearInterval(id)
  }, [on])
}

/** 输入框里左上角的「交回给：…」标签（ChatComposer 的 above）：点 × 就是普通消息，那件事还挂着 */
export function HandBackTag({ task }: { task: Pick<Task, 'userActions'> }) {
  useStoreVersion()
  const a = pendingAction(task)
  if (!a) return null
  if (detached.has(a.id))
    return (
      <div className="px-4 pt-3">
        <button
          type="button"
          onClick={() => {
            detached.delete(a.id)
            bump()
          }}
          className="cursor-pointer text-caption text-subtle hover:text-warning"
        >
          {t('这条是普通消息 · 点这里改成交回')}
        </button>
      </div>
    )
  return (
    <div className="flex min-w-0 px-4 pt-3">
      <span
        data-hand-back
        className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md bg-warning/12 pr-0.5 pl-2 text-caption text-warning"
        title={t('发送就是把结果交回给它：贴日志、拖文件、写看到了什么都可以')}
      >
        <Hand className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{t('交回给：{title}', { title: a.title })}</span>
        <button
          type="button"
          aria-label={t('不交回，当普通消息发')}
          title={t('不交回，当普通消息发')}
          onClick={() => {
            detached.add(a.id)
            bump()
          }}
          className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded hover:bg-warning/15"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    </div>
  )
}

/** 输入框上方浮着的「等你操作」面板（对话页的 FloatAbove 里）：展开看步骤，收起是一行转圈 */
export function UserActionPanel({ task, onChanged }: { task: Task; onChanged: (t: Task) => void }) {
  useStoreVersion()
  const a = pendingAction(task)
  useTick(!!a)
  if (!a || task.imported) return null
  return folded.has(a.id) ? (
    <Collapsed a={a} task={task} onChanged={onChanged} />
  ) : (
    <Expanded a={a} task={task} onChanged={onChanged} />
  )
}

type Props = { a: UserAction; task: Task; onChanged: (t: Task) => void }

// 浮在消息上面：深色主题的提问底色是半透明的，下面垫一层不透明的卡片底，消息的字才不会透上来
const box =
  'relative mx-auto mb-2 flex w-full max-w-(--content-w) flex-col rounded-xl bg-card bg-[linear-gradient(var(--ask-bg),var(--ask-bg))] shadow-[0_0_0_1px_var(--ask-line),var(--shadow-pop)] animate-[pop-in_160ms_ease-out]'

function useSettle({ a, task, onChanged }: Props) {
  const [busy, setBusy] = useState<'' | 'done' | 'cannot' | 'skipped'>('')
  const settle = async (how: 'done' | 'cannot' | 'skipped', reason = '') => {
    setBusy(how)
    try {
      onChanged(await api.settleUserAction(task.id, a.id, how, reason))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return { busy, settle }
}

function Head({ a, open }: { a: UserAction; open: boolean }) {
  return (
    <>
      <Spinner className="h-3 w-3 text-warning" />
      <span className="shrink-0 font-semibold text-warning">{t('等你操作')}</span>
      <span className="shrink-0 text-caption text-subtle tabular-nums">
        {t('已等 {took}', { took: waitedText(a) })}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => {
          if (open) folded.add(a.id)
          else folded.delete(a.id)
          bump()
        }}
        aria-label={open ? t('收起') : t('展开')}
        title={open ? t('收起') : t('展开')}
        className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-card hover:text-fg"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
    </>
  )
}

function Collapsed(p: Props) {
  const { busy, settle } = useSettle(p)
  return (
    <div className={cn(box, 'px-3 py-1.5')} role="status" aria-label={t('等你操作')}>
      <div className="flex min-w-0 items-center gap-2 text-body">
        <Spinner className="h-3 w-3 text-warning" />
        <span className="shrink-0 font-semibold text-warning">{t('等你操作')}</span>
        <span className="min-w-0 flex-1 truncate">{p.a.title}</span>
        <span className="shrink-0 text-caption text-subtle tabular-nums">{waitedText(p.a)}</span>
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-xs"
          disabled={!!busy}
          onClick={() => settle('done')}
        >
          {busy === 'done' && <Loader2 className="h-3 w-3 animate-spin" />}
          {t('完成了')}
        </Button>
        <button
          type="button"
          onClick={() => {
            folded.delete(p.a.id)
            bump()
          }}
          aria-label={t('展开')}
          title={t('展开')}
          className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-card hover:text-fg"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function Expanded(p: Props) {
  const { a } = p
  const { busy, settle } = useSettle(p)
  // 「做不了…」先展开一行写原因：Agent 要知道为什么做不了才能换办法
  const [why, setWhy] = useState<string | null>(null)
  const c = a.collect
  return (
    <div className={cn(box, 'gap-2 px-3 py-2.5')} role="region" aria-label={t('等你操作')}>
      <div className="flex min-w-0 items-center gap-2 text-body">
        <Head a={a} open />
      </div>
      <div className="flex flex-col gap-0.5 px-0.5">
        <p className="text-prose font-medium">{a.title}</p>
        {a.why && <p className="text-footnote text-muted">{a.why}</p>}
      </div>
      <ol className="flex max-h-[min(40vh,320px)] flex-col gap-1 overflow-y-auto px-0.5">
        {c.steps.map((s, i) => (
          <li key={i} className="flex gap-2 text-body">
            <span className="mt-px grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-card font-mono text-micro text-subtle tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 break-words">{s}</span>
          </li>
        ))}
      </ol>
      {(c.where || c.filter || c.expect) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-0.5 text-footnote">
          {c.where && (
            <>
              <dt className="text-subtle">{t('结果在')}</dt>
              <dd className="min-w-0 font-mono break-all">{c.where}</dd>
            </>
          )}
          {c.filter && (
            <>
              <dt className="text-subtle">{t('过滤')}</dt>
              <dd className="min-w-0 font-mono break-all">{c.filter}</dd>
            </>
          )}
          {c.expect && (
            <>
              <dt className="text-subtle">{t('怎么看')}</dt>
              <dd className="min-w-0">{c.expect}</dd>
            </>
          )}
        </dl>
      )}
      {a.alternative && (
        <details className="px-0.5 text-footnote">
          <summary className="cursor-pointer text-muted hover:text-fg">
            {t('也可以这样：{title}', { title: a.alternative.title })}
          </summary>
          <ol className="mt-1 list-decimal pl-5 text-body">
            {a.alternative.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}
      {why !== null && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && why.trim()) void settle('cannot', why.trim())
              if (e.key === 'Escape') setWhy(null)
            }}
            placeholder={t('为什么做不了？它会据此换个办法')}
            aria-label={t('做不了的原因')}
            className="h-8 min-w-0 flex-1 rounded-lg bg-card px-2.5 text-body outline-none placeholder:text-subtle focus:shadow-[0_0_0_1px_var(--ask-line)]"
          />
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!why.trim() || !!busy}
            onClick={() => void settle('cannot', why.trim())}
          >
            {busy === 'cannot' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('告诉它')}
          </Button>
        </div>
      )}
      {/* 提示单独一行：右栏窄的时候和三个按钮挤在一行会被折成好几行 */}
      <p className="px-0.5 text-caption text-subtle">
        {c.kind === 'confirm'
          ? t('做完点「完成了」；有话要说在下面输入框发送')
          : t('结果在下面输入框发送就交回给它（贴日志、拖文件都行）')}
      </p>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={!!busy}
          onClick={() => setWhy((v) => (v === null ? '' : null))}
        >
          {t('做不了…')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-xs"
          disabled={!!busy}
          title={a.fallback ? t('跳过的话：{fallback}', { fallback: a.fallback }) : undefined}
          onClick={() => void settle('skipped')}
        >
          {busy === 'skipped' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('跳过')}
        </Button>
        <Button
          size="sm"
          variant={c.kind === 'confirm' ? 'primary' : 'secondary'}
          className="h-7 text-xs"
          disabled={!!busy}
          onClick={() => void settle('done')}
        >
          {busy === 'done' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {c.kind === 'confirm' ? t('完成了') : t('完成了，没有要交回的')}
        </Button>
      </div>
      {a.fallback && (
        <p className="px-0.5 text-caption text-subtle">{t('跳过的话：{fallback}', { fallback: a.fallback })}</p>
      )}
    </div>
  )
}
