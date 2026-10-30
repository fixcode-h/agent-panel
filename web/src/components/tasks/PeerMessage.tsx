import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  ClipboardList,
  Copy,
  ExternalLink,
  FlaskConical,
  GitMerge,
  GitPullRequestArrow,
  Hammer,
  Loader2,
  MessageSquareReply,
  MessagesSquare,
  Scale,
  X,
} from 'lucide-react'
import { copyText } from '@/lib/copy-text'
import type { PeerKind, TaskMessage } from '@shared/schema'
import type { SendTarget } from '@/lib/tasks'
import { LEAD_TAG, parseReport, peerKindText, peerName, peerOfMessage, subjectLine } from '@shared/peer-message'
import type { PeerReport } from '@shared/peer-message'
import { convStateText } from '@shared/task'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Modal } from '@/components/ui/modal'
import { RowShell } from './ToolRow'
import { Markdown } from './Markdown'
import { useChildList, useChildOpen, usePeerMail } from './child-open'
import { replyOf } from '@/lib/tasks'

/** 消息类型的图标：收发两边同一套，一眼分得出是交代任务、上报、收尾还是编译 */
export const PEER_ICON: Record<PeerKind, typeof Activity> = {
  task: ClipboardList,
  answer: MessageSquareReply,
  question: CircleHelp,
  report: Activity,
  wrapup: GitPullRequestArrow,
  merge: GitMerge,
  build: Hammer,
  test: FlaskConical,
  rule: Scale,
  chat: MessagesSquare,
}

/** 类型小标签的颜色：报错一律红色；提问、请求收尾这种等对方处理的用强调色，其余淡色 */
function badgeTone(kind: PeerKind, failed?: boolean) {
  if (failed) return 'bg-danger/12 text-danger'
  if (kind === 'question' || kind === 'wrapup') return 'bg-accent/12 text-accent-text'
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
  /** 正文拆得出字段（子对话状态上报、计划步骤等的结果）：按字段排开，不画整段原文 */
  report?: PeerReport
  /** 上报时子对话的状态（ConvState）：状态小标签的颜色 */
  convState?: string
  /** 什么时候发的：交代任务那行按它找子对话后来回的信 */
  at?: string
  /** 同一个子对话后来又交了汇报、这封没被读就被替换了：整行变淡 */
  superseded?: boolean
}

/** 状态小标签的颜色：完成绿、失败红、中断和没做完琥珀、待收尾强调色 */
function stateTone(s?: string) {
  if (s === 'done') return 'bg-success/12 text-success'
  if (s === 'failed') return 'bg-danger/12 text-danger'
  if (s === 'stopped' || s === 'unfinished') return 'bg-warning/12 text-warning'
  if (s === 'wrapup') return 'bg-accent/12 text-accent-text'
  return 'bg-sel text-subtle'
}

/**
 * 汇报按字段排开：左边字段名、右边内容，最近的结果单独一段放在下面。
 * 原文是写给父对话 AI 的一整段，人看要一行行找；拆开后状态、哪个子对话、对应哪一步、下一步做什么一眼看到
 */
function ReportFields({ r, convState, big }: { r: PeerReport; convState?: string; big?: boolean }) {
  const rows: [string, React.ReactNode][] = []
  if (r.child || r.reason)
    rows.push([
      t('状态'),
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {r.state && (
          <span className={cn('rounded px-1.5 py-px text-[0.75rem] leading-4 font-medium', stateTone(convState))}>
            {r.state}
          </span>
        )}
        <span>{r.reason}</span>
      </span>,
    ])
  if (r.child) rows.push([t('子对话'), <span className="font-medium">{r.child}</span>])
  if (r.steps.length)
    rows.push([
      t('计划步骤'),
      <ul className="flex flex-col gap-1">
        {r.steps.map((s) => (
          <li key={s} className="flex items-baseline gap-2">
            <span>{s}</span>
            {r.stepsDone && (
              <span className="shrink-0 text-[0.75rem] text-success">
                <Check className="mr-0.5 inline h-3 w-3 align-[-1px]" aria-hidden />
                {t('已标完成')}
              </span>
            )}
          </li>
        ))}
      </ul>,
    ])
  if (r.next.length)
    rows.push([
      t('下一步'),
      <div className="flex flex-col gap-1">
        {r.next.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>,
    ])
  const tail = r.result || r.rest
  return (
    <div className={cn('flex flex-col gap-3', big ? 'text-[0.875rem]' : 'text-[0.8125rem]')}>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 leading-relaxed">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="pt-px text-[0.75rem] whitespace-nowrap text-subtle">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {tail && (
        <section className={cn(rows.length > 0 && 'border-t pt-3')}>
          {r.result && <h3 className="mb-1.5 text-[0.75rem] font-normal text-subtle">{t('最近的结果')}</h3>}
          <Markdown text={tail} teamNames={new Set()} />
        </section>
      )}
    </div>
  )
}

/**
 * 对话之间的一封信：开头固定是方向箭头 + 对方名字，然后是类型和内容标题（ADR 0034）。
 * 「接收消息 / 发送消息」几个字不再写，箭头已经说明了方向；标题截断也不会丢掉「谁发给谁」。
 * 点整行在下面展开全文，点中间的标题弹窗看全文
 */
export function PeerLine(p: PeerLineProps) {
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState(false)
  const openChild = useChildOpen()
  const Icon = PEER_ICON[p.kind]
  const Dir = p.dir === 'in' ? ArrowLeft : ArrowRight
  // 对方是子对话时写它的标题：几个子对话的角色名常常一样（都是「执行」），标题才分得清
  const party = p.childId ? p.title || p.name : p.name
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
  // 转交过来的提问在等人回答：整行描一圈琥珀色，和组件库「对话之间 · 转交提问」一致
  const ask = p.kind === 'question' && !p.failed
  return (
    <>
      <RowShell
        // 对话之间的消息和工具行一个样子，图标统一用「对话之间」的紫色，和工具行、用户消息分开
        glyph={
          p.running ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
          ) : (
            <Icon
              className={cn('h-3.5 w-3.5 shrink-0', p.failed ? 'text-danger' : ask ? 'text-warning' : 'text-peer')}
            />
          )
        }
        className={cn(ask && 'border-warning/45', p.superseded && 'opacity-55')}
        verb={
          <span
            className="inline-flex max-w-40 min-w-0 items-center gap-1"
            aria-label={
              p.dir === 'in' ? t('收到 {name} 的信', { name: party }) : t('发给 {name} 的信', { name: party })
            }
          >
            <Dir className="h-3 w-3 shrink-0 text-subtle" aria-hidden />
            <span className="min-w-0 truncate">{many ? t('{n} 个子对话', { n: many.length }) : party}</span>
          </span>
        }
        badge={peerKindText(p.kind)}
        badgeClass={badgeTone(p.kind, p.failed)}
        title={subject}
        titleClass="font-sans text-[0.75rem]"
        onOpen={() => setWin(true)}
        openTip={t('在窗口里查看这条消息')}
        detail={
          p.superseded ? (
            <span className="max-w-[40%] shrink-0 truncate text-[0.6875rem] text-subtle">{t('已被新的汇报取代')}</span>
          ) : p.dir === 'out' && !many && !p.failed && !p.running && p.childId && p.at ? (
            <LetterReceipt childId={p.childId} at={p.at} />
          ) : p.state || many ? (
            <span
              className={cn('max-w-[40%] shrink-0 truncate text-[0.6875rem]', ask ? 'text-warning' : 'text-subtle')}
              title={many ? names : undefined}
            >
              {p.state || names}
            </span>
          ) : undefined
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
              <Button variant="link" tone="muted" onClick={child} className="ml-auto shrink-0">
                <ExternalLink className="h-3 w-3" />
                {t('打开子对话')}
              </Button>
            )}
          </div>
          {many && <TargetList targets={many} openChild={openChild ?? undefined} />}
          <div className="max-h-[min(50vh,420px)] overflow-y-auto px-3 py-2 text-[0.8125rem]">
            {p.report ? (
              <ReportFields r={p.report} convState={p.convState} />
            ) : (
              <Markdown text={p.body || subject} teamNames={new Set()} />
            )}
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

/**
 * 交代任务那行的回执：已送达 → 对方在处理 → 已完成 · 看汇报（ADR 0034）。
 * 回执从子对话后来回的信和它现在的状态算出来，不另记数据，旧对话照样有；点「看汇报」滚到那一封
 */
function LetterReceipt({ childId, at }: { childId: string; at: string }) {
  const mail = usePeerMail()
  const kids = useChildList()
  if (!mail) return null
  const reply = replyOf(mail.letters.get(childId), at)
  const cls = 'max-w-[45%] shrink-0 truncate text-[0.6875rem]'
  if (reply) {
    const text =
      reply.kind === 'question'
        ? t('提了问题 · 去看')
        : reply.state === 'done' || reply.kind === 'merge'
          ? t('已完成 · 看汇报')
          : reply.failed || reply.state === 'failed'
            ? t('失败 · 看汇报')
            : t('已回复 · 看汇报')
    return (
      <button
        type="button"
        data-receipt="replied"
        onClick={(e) => {
          e.stopPropagation()
          const el = document.querySelector(`[data-letter="${CSS.escape(reply.id)}"]`)
          el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }}
        className={cn(
          cls,
          'cursor-pointer rounded px-1 hover:bg-sel',
          reply.failed || reply.state === 'failed' ? 'text-danger' : 'text-success',
        )}
      >
        {text} ↓
      </button>
    )
  }
  const kid = kids.find((k) => k.id === childId)
  if (!kid) return null
  return (
    <span
      data-receipt={kid.working ? 'working' : 'delivered'}
      className={cn(cls, kid.working ? 'text-accent-text' : 'text-subtle')}
    >
      {kid.working ? t('对方在处理') : t('已送达')}
    </span>
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
            <Button variant="link" tone="muted" onClick={() => openChild(x.child!)} className="ml-auto shrink-0">
              <ExternalLink className="h-3 w-3" />
              {t('打开')}
            </Button>
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
  report,
  convState,
  openChild,
  onClose,
}: PeerLineProps & { who: string; openChild?: () => void; onClose: () => void }) {
  const Icon = PEER_ICON[kind]
  const text = body || subject
  return (
    // 只看不填：点到外面就关；正文是长消息，比表单弹窗宽一档
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={null}
      size="xl"
      bare
      closeOnOutside
      className="max-h-[min(760px,calc(100dvh-2rem))] max-w-[860px]"
    >
      <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', failed ? 'text-danger' : 'text-subtle')} />
        <div className="min-w-0 flex-1">
          <D.Title className="truncate text-[0.875rem] font-medium" title={subject}>
            {subject}
          </D.Title>
          <div className="mt-0.5 flex items-center gap-2 text-[0.75rem] text-subtle">
            <span className={cn('rounded px-1.5 py-px leading-4', badgeTone(kind, failed))}>{peerKindText(kind)}</span>
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
        <IconButton
          size="sm"
          icon={Copy}
          label={t('复制')}
          onClick={() => void copyText(text, { done: t('已复制消息'), fail: false })}
        />
        <D.Close asChild>
          <IconButton size="sm" icon={X} label={t('关闭')} />
        </D.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[0.875rem]">
        {targets && targets.length > 1 && (
          <p className="mb-3 text-[0.75rem] text-subtle">{targets.map((x) => x.name).join('、')}</p>
        )}
        {report ? (
          <ReportFields r={report} convState={convState} big />
        ) : (
          <Markdown text={text} teamNames={new Set()} />
        )}
      </div>
      {receipt && !(targets && targets.length > 1) && (
        <footer className="shrink-0 border-t px-5 py-2 text-[0.75rem] text-subtle">{receipt}</footer>
      )}
    </Modal>
  )
}

/** 收到的一条消息（带 peer，或旧数据里子对话交回的上报）：画成「接收消息」；不是对话之间的消息返回 null */
export function ReceivedRow({ m }: { m: TaskMessage }) {
  const peer = peerOfMessage(m)
  if (!peer) return null
  const state = m.child?.state ? convStateText(m.child.state) : ''
  return (
    <div data-letter={m.id} className="min-w-0">
      <PeerLine
        dir="in"
        kind={peer.kind}
        name={peerName(peer)}
        title={peer.title}
        subject={peer.subject}
        body={peerBody(m.text)}
        failed={peer.failed}
        // 失败汇报要说清是「子对话自己这一轮跑挂了」，不是「汇报这个动作失败」——用户报的「汇报失败」其实是前者
        state={
          peer.kind === 'report' && peer.failed
            ? t('子对话自己这一轮失败')
            : peer.kind === 'report' && !peer.subject
              ? state
              : ''
        }
        childId={peer.rel === 'child' ? peer.id : undefined}
        report={parseReport(m.text) ?? undefined}
        convState={m.child?.state}
        at={m.at}
        superseded={peer.superseded}
      />
    </div>
  )
}
