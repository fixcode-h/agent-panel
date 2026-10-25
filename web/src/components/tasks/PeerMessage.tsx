import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import {
  Activity,
  ArrowDownLeft,
  Check,
  ArrowUpRight,
  CircleHelp,
  ClipboardList,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequestArrow,
  Hammer,
  Loader2,
  MessageSquareReply,
  MessagesSquare,
  Scale,
  X,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import type { PeerKind, TaskMessage } from '@shared/schema'
import type { SendTarget } from '@/lib/tasks'
import { LEAD_TAG, peerKindText, peerName, peerOfMessage, subjectLine } from '@shared/peer-message'
import { convStateText } from '@shared/task'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RowShell } from './ToolRow'
import { Markdown } from './Markdown'
import { useChildOpen } from './child-open'

/** 消息类型的图标：收发两边同一套，一眼分得出是交代任务、上报、收尾还是编译 */
export const PEER_ICON: Record<PeerKind, typeof Activity> = {
  task: ClipboardList,
  answer: MessageSquareReply,
  question: CircleHelp,
  report: Activity,
  wrapup: GitPullRequestArrow,
  merge: GitMerge,
  build: Hammer,
  rule: Scale,
  chat: MessagesSquare,
}

/** 类型小标签的颜色：报错一律红色；提问、请求收尾这种等对方处理的用强调色，其余淡色 */
function badgeTone(kind: PeerKind, failed?: boolean) {
  if (failed) return 'bg-danger/12 text-danger'
  if (kind === 'question' || kind === 'wrapup') return 'bg-accent/12 text-accent'
  return 'bg-sel text-subtle'
}

/** 正文里说给 AI 的开头标签、结尾那句「处理完这个结果后重新总结」不显示 */
export const peerBody = (text: string) =>
  text
    .replace(LEAD_TAG, '')
    // 「（id xxx）」是给 AI 调工具用的，界面上已经有打开子对话的按钮
    .replace(/（id:? [^）\s]+）/g, '')
    .replace(/\n处理完这个结果后[^\n]*$/, '')
    .trim()

export interface PeerLineProps {
  dir: 'in' | 'out'
  kind: PeerKind
  /** 对方是谁：收到时是发件方，发出时是收件方 */
  name: string
  /** 对方对话的标题（和角色名不同时在展开处写上） */
  title?: string
  subject: string
  body: string
  failed?: boolean
  /** 发送还没返回 */
  running?: boolean
  /** 右边补的一句：子对话上报时它的状态 */
  state?: string
  /** 对方是子对话时能打开它 */
  childId?: string
  /** 发出时面板给的回执（已实时送达、在后台执行……） */
  receipt?: string
  ms?: number
  /** 旧记录里同一段话逐个交给了几个子对话：只画一行，展开列出每个收件人和回执 */
  targets?: SendTarget[]
}

/** 行右侧写的来源：几个子对话的角色名相同时（都是「执行」），带上各自的对话标题才分得清是哪一条 */
function sideOf(p: PeerLineProps) {
  const title = p.title && p.title !== p.name ? p.title : ''
  if (p.dir === 'in')
    return title ? t('来自 {name}（{title}）', { name: p.name, title }) : t('来自 {name}', { name: p.name })
  return title ? t('发给 {name}（{title}）', { name: p.name, title }) : t('发给 {name}', { name: p.name })
}

/**
 * 对话之间的一条消息：「发送消息 / 接收消息 + 类型 + 内容标题」，像一次工具调用。
 * 点整行在下面展开全文，点中间的标题弹窗看全文
 */
export function PeerLine(p: PeerLineProps) {
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState(false)
  const openChild = useChildOpen()
  const Icon = PEER_ICON[p.kind]
  const Dir = p.dir === 'in' ? ArrowDownLeft : ArrowUpRight
  const subject = p.subject || subjectLine(p.body) || peerKindText(p.kind)
  const many = p.targets && p.targets.length > 1 ? p.targets : undefined
  const names = many?.map((x) => x.name).join('、') ?? ''
  const who =
    p.dir === 'in'
      ? t('已收到{name}发来的消息', { name: p.name })
      : many
        ? t('发给 {n} 个子对话的同一条消息', { n: many.length })
        : t('发给{name}的消息', { name: p.name })
  const child = !many && p.childId && openChild ? () => openChild(p.childId!) : undefined
  return (
    <>
      <RowShell
        glyph={
          p.running ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
          ) : (
            <Icon className={cn('h-3.5 w-3.5 shrink-0', p.failed ? 'text-danger' : 'text-subtle')} />
          )
        }
        verb={
          <span className="inline-flex items-center gap-0.5">
            {p.dir === 'in' ? t('接收消息') : t('发送消息')}
            <Dir className="h-3 w-3 text-subtle" aria-hidden />
          </span>
        }
        badge={peerKindText(p.kind)}
        badgeClass={badgeTone(p.kind, p.failed)}
        title={subject}
        onOpen={() => setWin(true)}
        openTip={t('在窗口里查看这条消息')}
        detail={
          <span className="max-w-[40%] shrink-0 truncate font-sans text-subtle">
            {[
              p.state,
              p.dir === 'in' ? sideOf(p) : many ? t('发给 {n} 个：{names}', { n: many.length, names }) : sideOf(p),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        }
        ms={p.ms}
        open={open}
        onToggle={() => setOpen(!open)}
        failed={p.failed}
      >
        <div className="border-t bg-card/60">
          <div className="flex items-center gap-2 px-3 pt-2 font-sans text-[0.75rem] text-subtle">
            <span className="min-w-0 truncate">
              {who}
              {p.title && p.title !== p.name ? ` · ${p.title}` : ''}
            </span>
            {child && (
              <button
                type="button"
                onClick={child}
                className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 hover:text-fg"
              >
                <ExternalLink className="h-3 w-3" />
                {t('打开子对话')}
              </button>
            )}
          </div>
          {many && <TargetList targets={many} openChild={openChild ?? undefined} />}
          <div className="max-h-[min(50vh,420px)] overflow-y-auto px-3 py-2 text-[0.8125rem]">
            <Markdown text={p.body || subject} teamNames={new Set()} />
          </div>
          {p.receipt && !many && (
            <div className="border-t px-3 py-1.5 font-sans text-[0.75rem] text-subtle">{p.receipt}</div>
          )}
        </div>
      </RowShell>
      {win && <PeerDialog {...p} subject={subject} who={who} openChild={child} onClose={() => setWin(false)} />}
    </>
  )
}

/** 同一段话的几个收件人：每人一行，送到没有、面板的回执（取第一行），子对话可以直接打开 */
function TargetList({ targets, openChild }: { targets: SendTarget[]; openChild?: (id: string) => void }) {
  return (
    <ul className="mx-3 mt-2 flex flex-col divide-y rounded-md border font-sans text-[0.75rem]">
      {targets.map((x, i) => (
        <li key={`${x.child ?? x.name}-${i}`} className="flex min-w-0 items-center gap-2 px-2 py-1">
          {x.failed ? (
            <X className="h-3 w-3 shrink-0 text-danger" aria-label={t('没送到')} />
          ) : (
            <Check className="h-3 w-3 shrink-0 text-subtle" aria-label={t('已送达')} />
          )}
          <span className="shrink-0 font-medium">{x.name}</span>
          {x.receipt && (
            <span className={cn('min-w-0 flex-1 truncate', x.failed ? 'text-danger' : 'text-subtle')} title={x.receipt}>
              {x.receipt.split('\n')[0]}
            </span>
          )}
          {x.child && openChild && (
            <button
              type="button"
              onClick={() => openChild(x.child!)}
              className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-subtle hover:text-fg"
            >
              <ExternalLink className="h-3 w-3" />
              {t('打开')}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function PeerDialog({
  subject,
  who,
  kind,
  body,
  failed,
  title,
  name,
  receipt,
  targets,
  openChild,
  onClose,
}: PeerLineProps & { who: string; openChild?: () => void; onClose: () => void }) {
  const Icon = PEER_ICON[kind]
  const text = body || subject
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(760px,calc(100dvh-2rem))] w-[min(860px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', failed ? 'text-danger' : 'text-subtle')} />
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-[0.875rem] font-medium" title={subject}>
                {subject}
              </D.Title>
              <div className="mt-0.5 flex items-center gap-2 text-[0.75rem] text-subtle">
                <span className={cn('rounded px-1.5 py-px leading-4', badgeTone(kind, failed))}>
                  {peerKindText(kind)}
                </span>
                <span className="min-w-0 truncate">
                  {who}
                  {title && title !== name ? ` · ${title}` : ''}
                </span>
              </div>
            </div>
            {openChild && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onClose()
                  openChild()
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('打开子对话')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制')}
              title={t('复制')}
              onClick={() =>
                navigator.clipboard
                  ?.writeText(text)
                  .then(() => toast.success(t('已复制消息')))
                  .catch(() => {})
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[0.875rem]">
            {targets && targets.length > 1 && (
              <p className="mb-3 text-[0.75rem] text-subtle">{targets.map((x) => x.name).join('、')}</p>
            )}
            <Markdown text={text} teamNames={new Set()} />
          </div>
          {receipt && !(targets && targets.length > 1) && (
            <footer className="shrink-0 border-t px-5 py-2 text-[0.75rem] text-subtle">{receipt}</footer>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 收到的一条消息（带 peer，或旧数据里子对话交回的上报）：画成「接收消息」；不是对话之间的消息返回 null */
export function ReceivedRow({ m }: { m: TaskMessage }) {
  const peer = peerOfMessage(m)
  if (!peer) return null
  const state = m.child?.state ? convStateText(m.child.state) : ''
  return (
    <PeerLine
      dir="in"
      kind={peer.kind}
      name={peerName(peer)}
      title={peer.title}
      subject={peer.subject}
      body={peerBody(m.text)}
      failed={peer.failed}
      state={peer.kind === 'report' && !peer.subject ? state : ''}
      childId={peer.rel === 'child' ? peer.id : undefined}
    />
  )
}
