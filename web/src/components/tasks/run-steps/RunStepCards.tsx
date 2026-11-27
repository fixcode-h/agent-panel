/**
 * 工作流对话的「对话」视图里按节点分段铺开（方案 A「节点分段」，用户 2026-11-27 定）：
 * 以前对话里只有一张工作流卡片，下面一片空白，看不出各节点在做什么。
 * 现在一个主流程节点一段：做完的是一张摘要卡（结论 + 产出），在跑的展开看最近几次工具调用，
 * 没开始的一行灰字；点节点标题就地展开这个节点的完整对话（和右栏「输出」页同一份 StepSection）
 */
import { memo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileText,
  MessageSquare,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import type { Task, TaskMessage, TaskStep } from '@shared/schema'
import { stepTree, topSteps } from '@shared/flow'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { stepDuration, verdictText } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Collapse } from '@/components/ui/collapse'
import { StatusPill } from '@/components/ui/status-pill'
import { StepIcon } from '../TaskStatusIcon'
import { StepSection } from '../StepSection'
import { ToolRow } from '../ToolRow'
import { latestText, liveTools, stepFiles, stepMessages, stepReportCount, stepSummary } from './step-digest'

/** 卡片上最多列几个改过的文件，其余写「+N」 */
const FILES_SHOWN = 3

/** 这个节点和它下面的节点：状态、结论、交的结果、改的文件变了才要重画（流式增量每次都会换 task） */
const cardSig = (task: Task, s: TaskStep) =>
  [s, ...stepTree(task, s.id)]
    .map(
      (x) =>
        `${x.id}:${x.status}:${x.verdict}:${x.endedAt}:${x.awaitConfirm ? 1 : 0}:${x.submitted?.at ?? ''}:${x.changes.length}`,
    )
    .join('|') + `|${s.title}|${task.status}`

export function RunStepCards({
  task,
  run,
  teamNames,
  onStep,
}: {
  task: Task
  run: number
  teamNames: Set<string>
  /** 在流程图里选中这个节点 */
  onStep?: (id: string) => void
}) {
  const steps = topSteps(task, run)
  // 展开了完整对话的节点：只在这一页记着，默认都不展开（在跑的节点本来就显示最近几步）
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  if (!steps.length) return null
  return (
    <ol className="flex flex-col gap-2" aria-label={t('工作流节点')} data-run-steps={run}>
      {steps.map((s, i) => (
        <StepCard
          key={s.id}
          task={task}
          step={s}
          msgs={stepMessages(task, s.id)}
          sig={cardSig(task, s)}
          last={i === steps.length - 1}
          open={open.has(s.id)}
          teamNames={teamNames}
          onToggle={toggle}
          onStep={onStep}
        />
      ))}
    </ol>
  )
}

interface CardProps {
  task: Task
  step: TaskStep
  msgs: TaskMessage[]
  sig: string
  last: boolean
  open: boolean
  teamNames: Set<string>
  onToggle: (id: string) => void
  onStep?: (id: string) => void
}

/** 节点在左边竖线上的状态点，竖线连到下一个节点；做完的那段线是绿的 */
function Rail({ step, last }: { step: TaskStep; last: boolean }) {
  const done = step.status === 'done' || step.status === 'skipped'
  return (
    <span aria-hidden className="flex w-[22px] shrink-0 flex-col items-center">
      <span className="mt-[11px] grid h-[18px] w-[18px] shrink-0 place-items-center">
        <StepIcon status={step.status} className="h-[18px] w-[18px]" />
      </span>
      {!last && <span className={cn('-mb-3 mt-1 w-0.5 flex-1 rounded-full', done ? 'bg-success/45' : 'bg-line')} />}
    </span>
  )
}

/** 标题旁的状态：在跑、等确认、失败、跳过各一种；做完的有验收结论就写验收几轮 */
function StateTag({ step }: { step: TaskStep }) {
  if (step.status === 'running')
    return step.awaitConfirm ? (
      <StatusPill tone="wait">{t('等你确认')}</StatusPill>
    ) : (
      <StatusPill tone="run" spin>
        {t('执行中')}
      </StatusPill>
    )
  if (step.status === 'failed') return <Badge tone="danger">{t('失败')}</Badge>
  if (step.status === 'skipped') return <Badge>{t('跳过')}</Badge>
  if (step.status === 'done')
    return <Badge tone={step.verdict === 'fail' ? 'warning' : 'success'}>{verdictText(step) || t('完成')}</Badge>
  return null
}

/** 节点的产出：改过的文件、交过的阶段报告（点报告在流程图里打开这个节点看） */
function Outputs({ task, step, onStep }: { task: Task; step: TaskStep; onStep?: (id: string) => void }) {
  const files = stepFiles(task, step)
  const reports = stepReportCount(task, step)
  if (!files.length && !reports) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {reports > 0 && (
        <button
          type="button"
          onClick={() => onStep?.(step.id)}
          disabled={!onStep}
          className="flex cursor-pointer items-center gap-1 rounded-md bg-accent-soft px-1.5 text-footnote leading-[1.75] text-accent-text hover:brightness-110 disabled:cursor-default"
        >
          <ClipboardCheck className="h-3 w-3" />
          {t('阶段报告 {n} 版', { n: reports })}
        </button>
      )}
      {files.slice(0, FILES_SHOWN).map((f) => (
        <span
          key={f.path}
          title={f.path}
          className="flex max-w-64 min-w-0 items-center gap-1 rounded-md bg-sel/70 px-1.5 font-mono text-footnote leading-[1.75] text-muted"
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate">{f.path.split('/').at(-1)}</span>
          <span className="shrink-0 text-success">+{f.add}</span>
          <span className="shrink-0 text-danger">-{f.del}</span>
        </span>
      ))}
      {files.length > FILES_SHOWN && (
        <span className="text-footnote text-subtle">{t('另 {n} 个文件', { n: files.length - FILES_SHOWN })}</span>
      )}
    </div>
  )
}

/** 卡片底部的小按钮：看完整对话 / 收起、在流程图里看 */
function MiniAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof MessageSquare
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-footnote text-muted transition-colors hover:bg-sel hover:text-fg"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

function StepCardBase({ task, step, msgs, last, open, teamNames, onToggle, onStep }: CardProps) {
  const { agents } = useData()
  const live = step.status === 'running'
  // 做完在等确认的节点不算「在干活」：显示它交的结论，不显示最近几步
  const working = live && !step.awaitConfirm
  const now = useNow(live)
  const agent = agents.find((a) => a.id === step.agentId)
  const who = agent && (
    <span className="flex shrink-0 items-center gap-1.5 text-footnote text-muted">
      <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
      {agent.name}
    </span>
  )
  // 还没开始的节点：一行灰字，不占卡片
  if (step.status === 'pending' && !msgs.length)
    return (
      <li className="flex gap-3" data-step-card={step.id}>
        <Rail step={step} last={last} />
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-body text-subtle">
          <span className="min-w-0 truncate">{step.title}</span>
          <span className="shrink-0 text-footnote">· {t('等待执行')}</span>
          <span className="flex-1" />
          {step.kind === 'flow' ? <WorkflowIcon className="h-3.5 w-3.5" /> : who}
        </div>
      </li>
    )
  const time = stepDuration(step, now)
  const summary = working ? latestText(msgs) : stepSummary(step, msgs)
  const tools = working && !open ? liveTools(msgs) : []
  const flowBtn = onStep && <MiniAction icon={WorkflowIcon} label={t('在流程图里看')} onClick={() => onStep(step.id)} />
  return (
    <li className="flex gap-3" data-step-card={step.id}>
      <Rail step={step} last={last} />
      <Card
        className={cn(
          'min-w-0 flex-1',
          // 在跑的节点描一道运行色的边，一眼看出现在做到哪
          working && 'shadow-[0_0_0_1px_color-mix(in_oklab,var(--run)_45%,var(--line))]',
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(step.id)}
          aria-expanded={open}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--c-card-radius) px-3 py-2.5 text-left text-body"
        >
          <span className="min-w-0 truncate font-semibold">{step.title}</span>
          <StateTag step={step} />
          <span className="flex-1" />
          {step.kind === 'flow' ? <WorkflowIcon className="h-3.5 w-3.5 text-subtle" /> : who}
          {time && (
            <span className={cn('shrink-0 font-mono text-caption', live ? 'text-run' : 'text-subtle')}>{time}</span>
          )}
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-subtle" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-subtle" />
          )}
        </button>
        {!open && (
          <div className="flex flex-col gap-2 px-3 pb-3">
            {summary ? (
              <p className={cn('line-clamp-2', working ? 'text-prose leading-[1.65]' : 'text-body text-muted')}>
                {summary}
              </p>
            ) : (
              working && <p className="text-body text-subtle">{t('正在启动…')}</p>
            )}
            {tools.length > 0 && (
              // 最近几次工具调用：和对话里的工具行同一个组件，点开一样能看参数和输出
              <div className="proc-list flex flex-col rounded-lg bg-sel/45 px-2.5 py-1">
                {tools.map((x, i) => (
                  <ToolRow key={i} tool={x} task={task} />
                ))}
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Outputs task={task} step={step} onStep={onStep} />
              </div>
              {live && msgs.length > 0 && (
                <MiniAction
                  icon={MessageSquare}
                  label={t('看节点完整对话 · {n} 条', { n: msgs.length })}
                  onClick={() => onToggle(step.id)}
                />
              )}
              {live && flowBtn}
            </div>
          </div>
        )}
        <Collapse open={open}>
          <div className="flex flex-col gap-3 border-t px-3 pt-3 pb-3">
            <StepSection task={task} rootId={step.id} msgs={msgs} teamNames={teamNames} bare />
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Outputs task={task} step={step} onStep={onStep} />
              </div>
              {flowBtn}
              <MiniAction icon={ChevronDown} label={t('收起')} onClick={() => onToggle(step.id)} />
            </div>
          </div>
        </Collapse>
      </Card>
    </li>
  )
}

/** 消息对象都没换（流式增量只替换变了的那几条） */
const sameMsgs = (a: TaskMessage[], b: TaskMessage[]) => a.length === b.length && a.every((m, i) => m === b[i])

const StepCard = memo(
  StepCardBase,
  (a, b) =>
    a.sig === b.sig &&
    a.open === b.open &&
    a.last === b.last &&
    a.teamNames === b.teamNames &&
    !a.onStep === !b.onStep &&
    sameMsgs(a.msgs, b.msgs),
)
