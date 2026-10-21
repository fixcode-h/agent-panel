import { useState } from 'react'
import { ChevronDown, Clock, Coins, Crown, Hourglass } from 'lucide-react'
import type { StepUsage, Task, TaskStep, TaskTodo } from '@shared/schema'
import { useData } from '@/lib/data'
import { useNow } from '@/lib/useNow'
import { fmtClock, fmtDuration, fmtTokens, stepDepth, stepDuration, stepLabel, verdictText } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { isMainStep, mainStep, stepTree, topSteps } from '@shared/flow'
import { StepIcon, TaskStatusIcon } from './TaskStatusIcon'
import { t } from '@shared/i18n'
import { stepMs, taskDuration, turnStats, waitDuration } from '@shared/task'

/**
 * 任务进度：工作流按主流程节点列出状态、耗时和用量，对话按待办清单和轮次列出。
 * 宽屏时放在对话区左边的空白处，窄屏时在右栏里；上下文和用量在输入框下面的信息条里。
 */
export function TaskPanel({
  task,
  onStep,
  className,
}: {
  task: Task
  /** 点了某一步 */
  onStep?: (id: string) => void
  className?: string
}) {
  const { agents } = useData()
  const byId = new Map(agents.map((a) => [a.id, a]))
  const tops = topSteps(task)
  const main = mainStep(task)
  const done = tops.filter((s) => s.status === 'done').length
  // 执行中每秒刷新，节点耗时和总耗时实时走
  const now = useNow(task.status === 'running')
  const [open, setOpen] = useState(true)
  const extra =
    task.mode === 'workflow'
      ? tops.length
        ? `${done}/${tops.length}`
        : undefined
      : (task.todos ?? []).length
        ? `${task.todos.filter((td) => td.status === 'done').length}/${task.todos.length}`
        : undefined

  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-left text-[0.8125rem] font-semibold"
      >
        {t('任务进度')}
        <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />
        <span className="ml-auto text-xs font-normal text-subtle">{extra}</span>
      </button>
      {/* 限制高度，节点、Agent 多的时候在块里滚动，不把下面的块挤到很远 */}
      {open && (
        <div className="max-h-[320px] overflow-y-auto overscroll-contain px-3.5 pb-3.5">
          <TimeSummary task={task} now={now} />
          {task.mode === 'workflow' && main && (
            <MainRow step={main} agent={byId.get(main.agentId)} now={now} onStep={onStep} />
          )}
          {task.mode === 'workflow' ? (
            <ol className={cn('flex flex-col', main && 'ml-[7px] border-l border-line-strong pt-2 pl-3')}>
              {tops.map((st, si) => {
                const a = byId.get(st.agentId)
                const kids = stepTree(task, st.id)
                return (
                  <li key={st.id} className="relative flex gap-2.5 pb-3 last:pb-0">
                    {si < tops.length - 1 && (
                      <span className="absolute top-5 bottom-0 left-[7px] w-px bg-line-strong" />
                    )}
                    <span className="relative mt-0.5 bg-card">
                      <StepIcon status={st.status} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <button
                        type="button"
                        disabled={!onStep}
                        onClick={() => onStep?.(st.id)}
                        title={onStep ? t('在流程图里查看这一步') : undefined}
                        className="-mx-1.5 -my-0.5 flex flex-col gap-1 rounded-md px-1.5 py-0.5 text-left enabled:cursor-pointer enabled:hover:bg-sel"
                      >
                        <span
                          className={cn(
                            'text-[0.8125rem]',
                            st.status === 'pending' ? 'text-muted' : 'text-fg',
                            st.status === 'running' && 'font-medium',
                          )}
                        >
                          {st.title}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle">
                          {a && (
                            <span className="flex items-center gap-1.5">
                              <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                              {a.name}
                            </span>
                          )}
                          {st.kind === 'flow' && <span>{t('调用流程')}</span>}
                          {st.rounds > 0 && (
                            <span className={st.verdict === 'fail' ? 'text-warning' : 'text-success'}>
                              {verdictText(st)}
                            </span>
                          )}
                          {/* 耗时、token、命中率接在 Agent 后面，放不下再换行 */}
                          <StepStats step={st} kids={kids} now={now} />
                        </span>
                      </button>
                      {kids.length > 0 && (
                        <ul className="mt-0.5 flex flex-col gap-1 border-l border-line-strong pl-2.5">
                          {kids.map((k) => (
                            <li key={k.id} style={{ paddingLeft: (stepDepth(k) - 1) * 12 }}>
                              <button
                                type="button"
                                disabled={!onStep}
                                onClick={() => onStep?.(k.id)}
                                title={onStep ? t('查看这一步的输出') : undefined}
                                className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs enabled:cursor-pointer enabled:hover:bg-sel"
                              >
                                <StepIcon status={k.status} className="h-3.5 w-3.5" />
                                {/* 嵌套的主 Agent（调用的工作流）、派出的子 Agent：标出是谁在做 */}
                                {isMainStep(k) ? (
                                  <Crown className="h-3 w-3 shrink-0 text-accent" />
                                ) : (
                                  k.slot === 'sub' &&
                                  byId.get(k.agentId) && (
                                    <AgentAvatar
                                      icon={byId.get(k.agentId)!.icon}
                                      cli={byId.get(k.agentId)!.cli}
                                      size="xs"
                                    />
                                  )
                                )}
                                <span
                                  className={cn(
                                    'min-w-0 flex-1 truncate',
                                    k.status === 'pending' ? 'text-subtle' : 'text-muted',
                                  )}
                                  title={stepLabel(k)}
                                >
                                  {stepLabel(k)}
                                </span>
                                {k.verdict && (
                                  <span className={k.verdict === 'fail' ? 'text-warning' : 'text-success'}>
                                    {k.verdict === 'fail' ? t('不通过') : t('通过')}
                                  </span>
                                )}
                                {stepDuration(k, now) && (
                                  <span
                                    className="shrink-0 font-mono text-[0.6875rem] text-subtle tabular-nums"
                                    title={spanTitle(k)}
                                  >
                                    {stepDuration(k, now)}
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </span>
                  </li>
                )
              })}
            </ol>
          ) : (task.todos ?? []).length ? (
            <Todos todos={task.todos} />
          ) : (task.turns ?? []).length ? null : (
            <p className="text-xs leading-relaxed text-subtle">
              {t('直接对话没有固定步骤；Agent 列出待办清单或计划后会显示在这里。')}
            </p>
          )}
          {(task.turns ?? []).length > 0 && (
            <TurnRows
              task={task}
              now={now}
              byAgent={byId}
              label={task.mode === 'workflow' ? t('追加要求') : t('对话轮次')}
            />
          )}
          {task.mode === 'workflow' && (task.todos ?? []).length > 0 && (
            <div className="mt-3 border-t pt-2.5">
              <Todos todos={task.todos} byAgent={byId} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** 任务进度最上面的主 Agent：调度了几轮、整个流程的耗时，和它自己的用量 */
function MainRow({
  step,
  agent,
  now,
  onStep,
}: {
  step: TaskStep
  agent?: { name: string; icon: string; cli: string }
  now: number
  onStep?: (id: string) => void
}) {
  return (
    <div className="flex gap-2.5">
      <span className="relative mt-0.5 bg-card">
        <StepIcon status={step.status} />
      </span>
      <button
        type="button"
        disabled={!onStep}
        onClick={() => onStep?.(step.id)}
        title={t('主 Agent 评估子 Agent 的结果、决定流程怎么走，最后整理结果')}
        className="-mx-1.5 -my-0.5 flex min-w-0 flex-1 flex-col gap-1 rounded-md px-1.5 py-0.5 text-left enabled:cursor-pointer enabled:hover:bg-sel"
      >
        <span className={cn('flex items-center gap-1.5 text-[0.8125rem]', step.status === 'running' && 'font-medium')}>
          <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />
          {t('主 Agent')}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle">
          {agent && (
            <span className="flex items-center gap-1.5">
              <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
              {agent.name}
            </span>
          )}
          <span>{step.rounds ? t('调度 {n} 轮', { n: step.rounds }) : t('等节点交回结果')}</span>
        </span>
        <StepStats step={step} kids={[]} now={now} />
      </button>
    </div>
  )
}

/** 「开始 10:32:01 · 结束 10:35:12」 */
function spanTitle(s: { startedAt: string; endedAt: string; status: string }) {
  return [
    s.startedAt && t('开始 {time}', { time: fmtClock(s.startedAt) }),
    s.endedAt && s.status !== 'running' && t('结束 {time}', { time: fmtClock(s.endedAt) }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 任务进度顶上的时间：总耗时（含等用户的时间）、其中等你确认 / 回答的时间、开始和结束的时刻 */
function TimeSummary({ task, now }: { task: Task; now: number }) {
  const total = taskDuration(task, now)
  const wait = waitDuration(task, now)
  if (total < 1000) return null
  const running = task.status === 'running'
  const cells: [string, string, string?, string?][] = [
    [t('总耗时'), fmtDuration(total), running ? 'text-accent' : '', t('累计执行时间，不含两轮之间的空闲')],
    [t('等你处理'), wait >= 1000 ? fmtDuration(wait) : '—', '', t('等你确认操作、回答问题、查看节点结果的时间')],
    running
      ? [t('开始于'), fmtClock(task.createdAt)]
      : [t('结束于'), fmtClock(task.updatedAt), '', t('开始 {time}', { time: fmtClock(task.createdAt) })],
  ]
  return (
    <dl className="mb-3 grid grid-cols-3 gap-2 rounded-lg bg-field/60 px-2.5 py-2">
      {cells.map(([k, v, cls, tip]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5" title={tip}>
          <dt className="text-[0.6875rem] text-subtle">{k}</dt>
          <dd className={cn('truncate font-mono text-xs font-medium tabular-nums', cls)}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 工作流跑完后的追加要求 / 对话的每一轮：一轮一行，带耗时、等待和 token */
function TurnRows({
  task,
  now,
  byAgent,
  label,
}: {
  task: Task
  now: number
  byAgent: Map<string, { name: string; icon: string; cli: string }>
  label: string
}) {
  // 对话很长时只看最近的，免得这一块太长
  const turns = task.turns.slice(-20)
  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        (task.mode === 'workflow' || task.todos.length > 0) && 'mt-3 border-t pt-2.5',
      )}
    >
      <span className="text-[0.6875rem] text-subtle">
        {label}
        {task.turns.length > turns.length &&
          t('（最近 {n} 轮，共 {total} 轮）', { n: turns.length, total: task.turns.length })}
      </span>
      <ol className="flex flex-col gap-2">
        {turns.map((x, i) => {
          const a = byAgent.get(x.agentId)
          const st = turnStats(task, x, now)
          const step = { startedAt: x.startedAt, endedAt: x.endedAt, status: x.status, spentMs: 0 }
          return (
            <li key={x.id} className="flex gap-2">
              <TaskStatusIcon status={x.status} className="mt-px h-3.5 w-3.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn('truncate text-xs', x.status === 'running' ? 'font-medium text-fg' : 'text-muted')}
                  title={x.title}
                >
                  {x.title || t('第 {n} 轮', { n: task.turns.length - turns.length + i + 1 })}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-subtle">
                  {a && task.mode === 'workflow' && (
                    <span className="flex items-center gap-1">
                      <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                      {a.name}
                    </span>
                  )}
                  <Stats
                    ms={stepMs(step, now)}
                    wait={st.waitMs}
                    u={st}
                    running={x.status === 'running'}
                    span={spanTitle(step)}
                  />
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 节点的耗时、等你处理的时间和 token（含开始、验收、结束等子节点） */
function StepStats({ step, kids, now }: { step: TaskStep; kids: TaskStep[]; now: number }) {
  const all = [step, ...kids]
  return (
    <Stats
      ms={stepMs(step, now)}
      wait={all.reduce((n, s) => n + waitDuration(s, now), 0)}
      u={sumUsage(all)}
      running={step.status === 'running'}
      span={spanTitle(step)}
    />
  )
}

/** 耗时（悬停看开始、结束时刻）、其中等你处理的时间、token 和缓存命中率 */
function Stats({
  ms,
  wait,
  u,
  running,
  span,
}: {
  ms: number
  wait: number
  u: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>
  running: boolean
  span: string
}) {
  const tokens = u.inputTokens + u.outputTokens
  if (ms < 1000 && !tokens) return null
  const rate = u.inputTokens > 0 ? (u.cacheReadTokens ?? 0) / u.inputTokens : 0
  const item = 'flex items-center gap-1 whitespace-nowrap font-mono text-[0.6875rem] text-subtle tabular-nums'
  return (
    <>
      {ms >= 1000 && (
        <span className={cn(item, running && 'text-accent')} title={span}>
          <Clock className="h-3 w-3" />
          {fmtDuration(ms)}
        </span>
      )}
      {wait >= 1000 && (
        <span className={item} title={t('其中等你处理的时间')}>
          <Hourglass className="h-3 w-3" />
          {fmtDuration(wait)}
        </span>
      )}
      {tokens > 0 && (
        <span
          className={item}
          title={t('输入 {input} · 输出 {output} · 缓存命中 {hit}', {
            input: fmtTokens(u.inputTokens),
            output: fmtTokens(u.outputTokens),
            hit: fmtTokens(u.cacheReadTokens ?? 0),
          })}
        >
          <Coins className="h-3 w-3" />
          {fmtTokens(tokens)}
          {u.inputTokens > 0 && (
            <span className={cn(rate >= 0.5 && 'text-success')}>
              {t('· 命中 {n}%', { n: (rate * 100).toFixed(0) })}
            </span>
          )}
        </span>
      )}
    </>
  )
}

type Usage = Pick<StepUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'>

/** 几个节点的用量加起来 */
function sumUsage(steps: TaskStep[]): Usage {
  const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  for (const s of steps) if (s.usage) for (const k of Object.keys(u) as (keyof Usage)[]) u[k] += s.usage[k] ?? 0
  return u
}

/** CLI 的待办清单 / 计划；工作流里注明是哪个 Agent 的 */
function Todos({ todos, byAgent }: { todos: TaskTodo[]; byAgent?: Map<string, { name: string }> }) {
  const groups = new Map<string, TaskTodo[]>()
  for (const td of todos) groups.set(td.agentId, [...(groups.get(td.agentId) ?? []), td])
  return (
    <div className="flex flex-col gap-2.5">
      {[...groups].map(([id, list]) => (
        <div key={id} className="flex flex-col gap-1">
          {byAgent && (
            <span className="text-[0.6875rem] text-subtle">
              {t('{name} 的待办', { name: byAgent.get(id)?.name ?? 'Agent' })}
            </span>
          )}
          <ul className="flex flex-col gap-1">
            {list.map((td, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <StepIcon status={td.status} className="mt-px h-3.5 w-3.5" />
                <span
                  className={cn(
                    'min-w-0 flex-1 [overflow-wrap:anywhere]',
                    td.status === 'done' ? 'text-subtle line-through decoration-line-strong' : 'text-fg',
                    td.status === 'running' && 'font-medium',
                  )}
                >
                  {td.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
