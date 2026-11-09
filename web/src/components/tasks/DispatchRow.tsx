import { Fragment, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Split,
  type LucideIcon,
} from 'lucide-react'
import type { Task, TaskRoute, TaskStep } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { useData } from '@/lib/data'
import { toolArgs, toolView } from '@/lib/tasks'
import { rerouteTag, type Dispatch, type DispatchState } from '@/lib/fold-dispatch'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { RowShell } from './ToolRow'
import { HelperWindow } from './HelperCards'
import { useChildOpen } from './child-open'
import type { ChildSummary } from './child-line'

/** 派单在界面上的说法和图标：有分诊时按分诊的去向说，没有时按调用本身 */
const KIND: Record<
  'child-new' | 'child-resend' | 'subtask' | 'inline-edit',
  { label: () => string; icon: LucideIcon }
> = {
  'child-new': { label: () => t('新开子对话'), icon: GitBranch },
  'child-resend': { label: () => t('交回子对话'), icon: GitBranch },
  subtask: { label: () => t('派子任务'), icon: Split },
  'inline-edit': { label: () => t('就地微改动'), icon: Pencil },
}
const TARGET_KIND: Record<TaskRoute['target'], keyof typeof KIND> = {
  child: 'child-new',
  resend: 'child-resend',
  subtask: 'subtask',
  'inline-edit': 'inline-edit',
}

/** 改派的去向：说给协调器的话写中文（发给 Agent 的提示不翻译），菜单文字走 t() */
type Reroute = 'inline' | 'subtask' | 'child'
const REROUTE: Record<Reroute, { label: () => string; say: string }> = {
  inline: { label: () => t('改为就地处理'), say: '就地处理（你自己回答，或者走就地微改动）' },
  subtask: { label: () => t('改为子任务'), say: '派子任务处理' },
  child: { label: () => t('改为子对话'), say: '交给子对话处理' },
}
const SAY: Record<TaskRoute['target'], string> = {
  child: '新开子对话',
  resend: '交回子对话',
  subtask: '派子任务',
  'inline-edit': '就地微改动',
}

/** 每种去向能改成什么：已经是的那种不列 */
const OPTIONS: Record<TaskRoute['target'], Reroute[]> = {
  child: ['inline', 'subtask'],
  resend: ['inline', 'child'],
  subtask: ['inline', 'child'],
  'inline-edit': ['child'],
}

/** 发给协调器的改派消息 */
export function rerouteText(r: TaskRoute, to: Reroute) {
  const what = r.label ? `「${r.label}」` : '上一条'
  return `【改派】${what}不要${SAY[r.target]}，改为${REROUTE[to].say}${rerouteTag(r.id)}。已经派出去的先停掉或收回，再按新的方式处理。`
}

/** 行尾的状态胶囊 */
const STATUS: Record<DispatchState['status'], { text: () => string; cls: string }> = {
  running: { text: () => t('执行中'), cls: 'text-accent-text' },
  queued: { text: () => t('排队中'), cls: 'text-subtle' },
  needs: { text: () => t('等你处理'), cls: 'text-warning' },
  stopped: { text: () => t('已停止'), cls: 'text-subtle' },
  failed: { text: () => t('失败'), cls: 'text-danger' },
  done: { text: () => t('已完成'), cls: 'text-subtle' },
  rerouted: { text: () => t('已改派'), cls: 'text-subtle' },
}

function Glyph({ status, icon: Icon }: { status?: DispatchState['status']; icon: LucideIcon }) {
  if (status === 'running' || status === 'needs')
    return (
      <Loader2
        className={cn('h-3.5 w-3.5 shrink-0 animate-spin', status === 'needs' ? 'text-warning' : 'text-accent-text')}
      />
    )
  if (status === 'failed') return <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
  if (status === 'stopped') return <Pause className="h-3.5 w-3.5 shrink-0 text-subtle" />
  return <Icon className={cn('h-3.5 w-3.5 shrink-0', status === 'queued' ? 'text-subtle' : 'text-accent-text')} />
}

function StatusChip({ status }: { status: DispatchState['status'] }) {
  const s = STATUS[status]
  return (
    <span className={cn('flex shrink-0 items-center gap-1 font-sans text-caption', s.cls)}>
      {status === 'done' && <Check className="h-3 w-3" />}
      {s.text()}
    </span>
  )
}

/** 交出去的内容：子对话收到的那段话、就地改动的理由（发起它的那次调用的参数） */
function handoffOf(task: Task | undefined, d: Dispatch | undefined) {
  if (!task || !d || d.tool < 0) return ''
  const tool = task.messages.find((m) => m.id === d.msgId)?.tools[d.tool]
  if (!tool) return ''
  const a = toolArgs(tool)
  const text = d.kind === 'inline-edit' ? a.reason : a.message
  return typeof text === 'string' ? text.trim() : ''
}

/** 标题：子对话的名字、子任务的名字、就地改的文件；都没有时用分诊里记的标题 */
function titleOf(
  task: Task | undefined,
  d: Dispatch | undefined,
  kid: ChildSummary | undefined,
  steps: TaskStep[],
  route?: TaskRoute,
) {
  if (kid?.title) return kid.title
  if (d?.kind === 'subtask')
    return steps.length === 1 ? steps[0].title || route?.label || '' : t('{n} 个', { n: d.targets.length })
  if (d && d.tool >= 0) {
    const tool = task?.messages.find((m) => m.id === d.msgId)?.tools[d.tool]
    const label = tool ? toolView(tool)?.tool.label : ''
    if (label) return label
  }
  return route?.label ?? ''
}

/**
 * 派单行：新开 / 交回子对话、派子任务、就地微改动画成和工具调用一样的一行，分诊说明并进来
 * （设计稿：回复折叠与派单行重设计 §4）：
 * - 行尾是对象自己的状态；第二行小字放分诊的「理解」，理由、假设、交接内容点开看；改派收进 ⋯ 菜单
 * - 没办完的子对话、子任务在原位只写状态，实时那一行固定在输入框上方的运行区（用户 2026-11-09 要求恢复）
 * - 没有派单只有分诊的（旧数据对不上调用）也用这一行，只是没有状态
 */
export function DispatchRow({
  d,
  routes,
  state,
  task,
  kids = [],
  onReroute,
}: {
  d?: Dispatch
  routes: TaskRoute[]
  state?: DispatchState
  task?: Task
  kids?: ChildSummary[]
  /** 不给时只读（导入的对话） */
  onReroute?: (text: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [win, setWin] = useState('')
  const openChild = useChildOpen()
  const { agents } = useData()
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const route = routes[0]
  const kind: keyof typeof KIND | undefined =
    d && d.kind !== 'job' && d.kind !== 'run' ? d.kind : route ? TARGET_KIND[route.target] : undefined
  const isChild = d?.kind === 'child-new' || d?.kind === 'child-resend'
  const kid = isChild ? kids.find((k) => k.id === d.targets[0]) : undefined
  const steps =
    d?.kind === 'subtask'
      ? d.targets.map((id) => task?.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s)
      : []
  if (!kind) return null
  const { label, icon } = KIND[kind]
  const status = state?.status
  const title = titleOf(task, d, kid, steps, route)
  const handoff = handoffOf(task, d)
  const rerouted = status === 'rerouted'
  const rows = route
    ? ([
        [t('理解'), route.understanding],
        [t('理由'), route.reason],
        [t('假设'), route.assumptions],
      ].filter(([, v]) => v) as [string, string][])
    : []
  const canOpen = rows.length > 0 || !!handoff
  // 子任务只有一个时整行打开它的窗口；子对话整行打开子对话
  const openTarget =
    isChild && d.targets[0] && openChild
      ? () => openChild(d.targets[0])
      : d?.kind === 'subtask' && steps.length === 1 && task
        ? () => setWin(steps[0].id)
        : undefined
  const menu =
    route && onReroute && !rerouted && (state ? state.open : true) ? (
      <Menu modal={false}>
        <MenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('改派')}
            title={t('改派')}
            className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-fg/[0.06] hover:text-fg"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent>
          {OPTIONS[route.target].map((to) => (
            <MenuItem
              key={to}
              onSelect={async () => {
                setBusy(true)
                try {
                  await onReroute(rerouteText(route, to))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {REROUTE[to].label()}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    ) : null
  const transparent = '[--c-row-bg:transparent]'
  // 主行只写派单本身和状态胶囊：实时状态、去操作、终止都在输入框上方的运行区（用户 2026-11-09 要求运行中的固定显示在那里）
  const main = (
    <RowShell
      className={transparent}
      glyph={<Glyph status={status} icon={icon} />}
      verb={label()}
      title={title || undefined}
      titleClass={cn('font-sans text-footnote', rerouted && 'line-through decoration-subtle')}
      detail={status && <StatusChip status={status} />}
      open={open}
      onToggle={canOpen ? () => setOpen(!open) : undefined}
      onOpen={openTarget}
      openTip={isChild ? t('打开子对话') : undefined}
      failed={status === 'failed'}
      action={rows.length ? undefined : menu}
    />
  )
  // 一次派了几个子任务：组头下面每个子任务一行
  const group =
    d?.kind === 'subtask' && steps.length > 1 ? (
      <div className="flex flex-col pb-1 pl-6">
        {steps.map((s) => {
          const st: DispatchState['status'] =
            s.status === 'done' || s.status === 'skipped'
              ? 'done'
              : s.status === 'failed'
                ? 'failed'
                : s.interrupted
                  ? 'stopped'
                  : s.status === 'running'
                    ? 'running'
                    : 'queued'
          return (
            <RowShell
              key={s.id}
              className={transparent}
              glyph={<Glyph status={st} icon={Split} />}
              title={s.title || t('未命名')}
              titleClass="font-sans text-footnote"
              detail={<StatusChip status={st} />}
              open={false}
              rowOpen={task ? () => setWin(s.id) : undefined}
              onOpen={task ? () => setWin(s.id) : undefined}
              openTip={t('打开子任务「{title}」', { title: s.title || t('未命名') })}
            />
          )
        })}
      </div>
    ) : null
  return (
    <div
      data-dispatch={kind}
      data-dispatch-status={status ?? ''}
      className={cn('min-w-0 rounded-(--c-row-radius) bg-(--c-row-bg)', rerouted && 'opacity-70')}
    >
      {main}
      {group}
      {rows.length > 0 && (
        // 第二行小字：分诊的「理解」，点它展开理由、假设和交接内容；改派在行尾的 ⋯ 里
        <div className="flex min-w-0 items-center gap-1 pr-1 pb-1 pl-8">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={open ? t('收起分诊说明') : t('展开分诊说明')}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-caption text-subtle hover:text-muted"
          >
            <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
            <span className="min-w-0 truncate">{route.understanding || route.reason || route.assumptions}</span>
          </button>
          {menu}
        </div>
      )}
      {open && canOpen && (
        <div className="mx-3 mb-2 ml-8 flex flex-col gap-2 border-t border-line/60 pt-2 text-xs leading-relaxed">
          {rows.length > 0 && (
            <dl className="grid grid-cols-[2.25rem_1fr] gap-x-2 gap-y-1">
              {rows.map(([k, v]) => (
                <Fragment key={k}>
                  <dt className="text-subtle">{k}</dt>
                  <dd className="min-w-0 break-words text-muted">{v}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {handoff && (
            <div className="flex flex-col gap-1 border-t border-line/60 pt-2">
              <span className="text-subtle">{t('交接内容')}</span>
              <p className="max-h-[min(40vh,320px)] overflow-y-auto whitespace-pre-wrap break-words text-muted">
                {handoff}
              </p>
            </div>
          )}
        </div>
      )}
      {task && win && <HelperWindow task={task} id={win} teamNames={teamNames} onClose={() => setWin('')} />}
    </div>
  )
}
