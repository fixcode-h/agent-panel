import { useState } from 'react'
import {
  ChevronDown,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  ScanSearch,
  Shrink,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { getCli } from '@shared/clis'
import { agentRun, cliSettings, defaultSettings } from '@shared/settings'
import { LimitBars, LIMIT_CLIS, useCliLimits } from '@/components/settings/CliLimits'
import {
  DEFAULT_AGENT_ID,
  type FileChange,
  type Project,
  type StepUsage,
  type Task,
  type TaskStep,
  type TaskTodo,
  type Workflow,
} from '@shared/schema'
import { useData } from '@/lib/data'
import { fmtTokens, stepDepth, stepLabel, verdictText } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { useDirInfo } from '@/components/projects/DirPicker'
import { stepTree, topSteps } from '@shared/flow'
import { StepIcon } from './TaskStatusIcon'
import { useAgentView } from '@/lib/agent-view'
import { Terminal } from '@/components/agents/CommandPreview'
import { t } from '@shared/i18n'
import { mergeChanges, taskSummary, withTaskModel } from '@shared/task'
import { DiffDialog } from './DiffDialog'

/** 右栏块里的小操作（压缩上下文、审查改动） */
const panelAction =
  'mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-60'

/** 任务用到的 CLI 里打开了「显示额度」的，每个显示一组额度 */
function LimitsSection({ task }: { task: Task }) {
  const { agents, settings } = useData()
  const s = settings ?? defaultSettings()
  const ids = new Set<string>()
  for (const id of [task.agentId, ...Object.keys(task.usage.agents)]) {
    const a = agents.find((x) => x.id === id)
    if (a) ids.add(agentRun(withTaskModel(a, task), s).cli)
  }
  const shown = [...ids].filter((c) => LIMIT_CLIS.includes(c) && cliSettings(s, c).showLimits)
  if (!shown.length) return null
  return (
    <Section title={t('额度')}>
      <div className="flex flex-col gap-4">
        {shown.map((c) => (
          <CliLimitRows key={c} cli={c} named={shown.length > 1} />
        ))}
      </div>
    </Section>
  )
}

function CliLimitRows({ cli, named }: { cli: string; named: boolean }) {
  const { data, error } = useCliLimits(cli, true)
  return (
    <div className="flex flex-col gap-2">
      {named && <p className="text-[12px] font-medium">{getCli(cli)?.name}</p>}
      {data?.windows.length ? (
        <LimitBars data={data} compact />
      ) : (
        <p className="text-xs text-subtle">
          {error ? t('读取失败：{error}', { error }) : cli === 'claude' ? t('执行后会显示') : t('读取中…')}
        </p>
      )}
    </div>
  )
}

/**
 * 启动命令：点了流程节点时是这个节点最近一次启动的命令（调用流程的节点看它里面最近启动的）；
 * 对话任务用任务上记的那条。复制出来可以自己在终端里跑一遍排查问题。
 */
function CommandSection({ task, scope }: { task: Task; scope?: TaskStep[] }) {
  // 节点自己的命令优先；调用流程的节点自己不启动 CLI，看它里面最近启动的
  const last = scope?.[0].command.length
    ? scope[0]
    : scope
        ?.filter((s) => s.command.length)
        .sort((a, b) =>
          a.status === 'running' ? -1 : b.status === 'running' ? 1 : b.startedAt.localeCompare(a.startedAt),
        )[0]
  const argv = scope ? last?.command : task.command
  if (!scope && !argv?.length) return null
  return (
    <Section title={t('启动命令')} extra={scope && last && last.id !== scope[0].id ? stepLabel(last) : undefined}>
      {argv?.length ? (
        <Terminal argv={argv} title={argv[0].split(/[\\/]/).pop()} className="rounded-lg" />
      ) : (
        <p className="text-xs text-subtle">{t('这个节点还没有启动过 CLI。')}</p>
      )}
    </Section>
  )
}

function Section({
  title,
  extra,
  className,
  children,
}: {
  title: string
  extra?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className={cn('rounded-xl border bg-card', className)}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-left text-[13px] font-semibold"
      >
        {title}
        <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />
        <span className="ml-auto text-xs font-normal text-subtle">{extra}</span>
      </button>
      {/* 每块限制高度，节点、Agent 多的时候在块里滚动，不把下面的块挤到很远 */}
      {open && <div className="max-h-[320px] overflow-y-auto overscroll-contain px-3.5 pb-3.5">{children}</div>}
    </section>
  )
}

/** 任务页右栏：任务进度、上下文、更改、环境，参考 Claude Code 的会话侧栏 */
export function TaskPanel({
  task,
  project,
  workflow,
  onStep,
  only,
  progressClass,
  node,
  onTask,
}: {
  task: Task
  /** 压缩、审查开始后把新的任务状态交回页面 */
  onTask?: (t: Task) => void
  /** 只显示任务进度（宽屏时任务进度单独放在左边） */
  only?: 'progress'
  /** 任务进度这一块的额外样式：宽屏时右栏里藏起来，免得和左边重复 */
  progressClass?: string
  /** Chat 模式的聊天没有项目 */
  project?: Project
  workflow?: Workflow
  /** 点了任务进度里的某一步 */
  onStep?: (id: string) => void
  /** 流程图里选中的节点：启动命令、上下文、Token、更改只看这个节点（含它的子节点）；没有时看整个任务 */
  node?: TaskStep
}) {
  const { modelOf } = useAgentView()
  const { agents, settings } = useData()
  const dir = useDirInfo(project?.path ?? '')
  const [busy, setBusy] = useState<'' | 'compact' | 'review'>('')
  const act = async (what: 'compact' | 'review') => {
    setBusy(what)
    try {
      const next = what === 'compact' ? await api.compactTask(task.id) : await api.reviewTask(task.id)
      onTask?.(next)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const idle = task.status !== 'running'
  const byId = new Map(agents.map((a) => [a.id, a]))
  // 用默认 Agent 的对话按 CLI 显示：名字和颜色跟着对话现在用的 CLI
  const rowAgent = (a?: { id: string; name: string; icon: string; cli: string; model: string; effort: string }) => {
    if (!a || task.mode !== 'chat' || a.id !== task.agentId || a.id !== DEFAULT_AGENT_ID) return a
    const cli = agentRun(withTaskModel(a, task), settings ?? defaultSettings()).cli
    return { ...a, cli, name: getCli(cli)?.name ?? a.name }
  }
  const tops = topSteps(task)
  const done = tops.filter((s) => s.status === 'done').length
  // 工作流任务：对话视图看整个任务的上下文和用量，不显示启动命令和更改（它们属于具体节点）；
  // 流程图里点了节点才看这个节点的。对话任务只有一个 Agent，一直显示
  const workflowMode = task.mode === 'workflow'
  const scope = node ? [node, ...task.steps.filter((s) => s.id.startsWith(node.id + '/'))] : undefined
  const changes = scope ? sumChanges(scope) : task.changes
  const add = changes.reduce((n, c) => n + c.add, 0)
  const del = changes.reduce((n, c) => n + c.del, 0)
  // 对话视图里的上下文：每个流程节点一行，调用流程的节点看它里面最近跑的那个
  const nodeRows = workflowMode
    ? tops.flatMap((st) => {
        const own = st.usage?.window ? st : undefined
        const sub = task.steps
          .filter((s) => s.id.startsWith(st.id + '/') && s.usage?.window)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
        const src = own ?? sub
        return src ? [{ step: { ...st, agentId: src.agentId }, usage: src.usage! }] : []
      })
    : []
  const nodeTag = node && <span className="block max-w-[150px] truncate">{node.title}</span>
  const found = byId.get(task.agentId)
  // 对话里选的 CLI、模型盖在默认 Agent 上，显示实际用的
  const chatAgent = found && withTaskModel(found, task)
  const { upsertTask } = useData()
  const [diffPath, setDiffPath] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <DiffDialog
        task={task}
        path={diffPath}
        onOpenChange={(o) => !o && setDiffPath(null)}
        onReverted={(x) => upsertTask(taskSummary(x))}
      />
      <Section
        title={t('任务进度')}
        className={progressClass}
        extra={
          task.mode === 'workflow'
            ? tops.length
              ? `${done}/${tops.length}`
              : undefined
            : (task.todos ?? []).length
              ? `${task.todos.filter((td) => td.status === 'done').length}/${task.todos.length}`
              : undefined
        }
      >
        {task.mode === 'workflow' ? (
          <ol className="flex flex-col">
            {tops.map((st, si) => {
              const a = byId.get(st.agentId)
              const kids = stepTree(task, st.id)
              return (
                <li key={st.id} className="relative flex gap-2.5 pb-3 last:pb-0">
                  {si < tops.length - 1 && <span className="absolute top-5 bottom-0 left-[7px] w-px bg-line-strong" />}
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
                          'text-[13px]',
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
                      </span>
                    </button>
                    {kids.length > 0 && (
                      <ul className="mt-0.5 flex flex-col gap-1 border-l border-line-strong pl-2.5">
                        {kids.map((k) => (
                          <li
                            key={k.id}
                            className="flex items-center gap-1.5 text-xs"
                            style={{ paddingLeft: (stepDepth(k) - 1) * 12 }}
                          >
                            <StepIcon status={k.status} className="h-3.5 w-3.5" />
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
        ) : (
          <p className="text-xs leading-relaxed text-subtle">
            {t('直接对话没有固定步骤；Agent 列出待办清单或计划后会显示在这里。')}
          </p>
        )}
        {task.mode === 'workflow' && (task.todos ?? []).length > 0 && (
          <div className="mt-3 border-t pt-2.5">
            <Todos todos={task.todos} byAgent={byId} />
          </div>
        )}
      </Section>

      {only !== 'progress' && (
        <>
          {(!workflowMode || scope) && <CommandSection task={task} scope={scope} />}
          {/* 演示里的模拟执行也写每个 Agent 的用量，和真实执行用同一个视图 */}
          <Section title={t('上下文')} extra={nodeTag ?? (task.simulated ? t('模拟') : t('CLI 报告'))}>
            {scope ? (
              scope.some((s) => s.usage?.window) ? (
                <ul className="flex flex-col gap-3">
                  {scope
                    .filter((s) => s.usage?.window)
                    .map((s) => (
                      <ContextRow
                        key={s.id}
                        agent={byId.get(s.agentId)}
                        label={s === node ? undefined : stepLabel(s)}
                        u={s.usage!}
                        live={s.status === 'running' ? task.usage.agents[s.agentId] : undefined}
                      />
                    ))}
                </ul>
              ) : (
                <p className="text-xs text-subtle">{t('这个节点的 CLI 运行后会显示上下文占用。')}</p>
              )
            ) : nodeRows.length ? (
              // 工作流按流程节点一行：同一个 Agent 跑了好几个节点也分开看
              <ul className="flex flex-col gap-3">
                {nodeRows.map(({ step: st, usage: u }) => (
                  <ContextRow
                    key={st.id}
                    agent={byId.get(st.agentId)}
                    label={st.title}
                    u={u}
                    live={st.status === 'running' ? task.usage.agents[st.agentId] : undefined}
                  />
                ))}
              </ul>
            ) : Object.keys(task.usage.agents).length === 0 ? (
              <p className="text-xs text-subtle">{t('CLI 开始运行后会显示上下文占用。')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {Object.entries(task.usage.agents).map(([id, u]) => (
                  <ContextRow key={id} agent={rowAgent(byId.get(id))} u={u} live={u} />
                ))}
              </ul>
            )}
            {/* 对话停着时可以手动压缩：上下文快满、话题换了的时候 */}
            {!workflowMode && !scope && idle && !task.simulated && Object.keys(task.sessions).length > 0 && (
              <button
                onClick={() => act('compact')}
                disabled={!!busy}
                title={t('让 CLI 把之前的对话压缩成摘要，腾出上下文')}
                className={panelAction}
              >
                {busy === 'compact' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Shrink className="h-3.5 w-3.5" />
                )}
                {t('压缩上下文')}
              </button>
            )}
          </Section>
          {!scope && <LimitsSection task={task} />}

          {scope ? (
            <TokenUsage
              usage={sumUsage(scope)}
              tps={scope
                .filter((s) => s.status === 'running')
                .reduce((n, s) => n + (task.usage.agents[s.agentId]?.tps ?? 0), 0)}
              extra={nodeTag}
            />
          ) : !task.simulated || task.usage.inputTokens > 0 ? (
            <TokenUsage
              usage={task.usage}
              tps={Object.values(task.usage.agents).reduce((n, a) => n + (a.tps ?? 0), 0)}
            />
          ) : null}

          {(!workflowMode || scope) && (
            <Section
              title={t('更改')}
              extra={
                changes.length ? (
                  <span className="font-mono">
                    <span className="text-success">+{add}</span>
                    {del > 0 && <span className="text-danger"> -{del}</span>}
                  </span>
                ) : (
                  nodeTag
                )
              }
            >
              {changes.length ? (
                <ul className="flex flex-col gap-1">
                  {changes.map((c) => (
                    <li key={c.path}>
                      <button
                        type="button"
                        onClick={() => setDiffPath(c.path)}
                        title={t('查看「{path}」的改动', { path: c.path })}
                        className="-mx-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left font-mono text-xs transition-colors hover:bg-sel"
                      >
                        <span className="min-w-0 flex-1 truncate text-muted">{c.path}</span>
                        <span className="shrink-0 text-success">+{c.add}</span>
                        <span className="w-8 shrink-0 text-right text-danger">{c.del ? `-${c.del}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-subtle">{scope ? t('这个节点没有改动文件。') : t('还没有改动文件。')}</p>
              )}
              {/* 让 CLI 只读地审查一遍改动：Codex 用自己的审查模式 */}
              {!scope && idle && !task.simulated && !!dir?.gitBranch && changes.length > 0 && (
                <button
                  onClick={() => act('review')}
                  disabled={!!busy}
                  title={t('让 CLI 审查还没提交的改动，只列问题，不改文件')}
                  className={panelAction}
                >
                  {busy === 'review' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ScanSearch className="h-3.5 w-3.5" />
                  )}
                  {t('审查改动')}
                </button>
              )}
            </Section>
          )}

          <Section title={t('环境')}>
            <ul className="flex flex-col gap-2 text-xs text-muted">
              <li className="flex items-center gap-2">
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
                {project ? (
                  <span className="min-w-0 truncate font-mono" title={project.path}>
                    {project.path || t('未选择目录')}
                  </span>
                ) : (
                  <span className="min-w-0 truncate">{t('聊天，不在任何项目里')}</span>
                )}
              </li>
              {dir?.gitBranch && (
                <li className="flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="truncate font-mono">{dir.gitBranch}</span>
                </li>
              )}
              <li className="flex items-center gap-2">
                {task.mode === 'workflow' ? (
                  <>
                    <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    <span className="truncate">
                      {t('工作流：{name}', { name: workflow?.name ?? t('已删除的工作流') })}
                    </span>
                  </>
                ) : (
                  <>
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    <span className="truncate">
                      {t('对话：{name}', { name: rowAgent(found)?.name || t('已删除的 Agent') })}
                      {chatAgent && <span className="font-mono text-subtle"> · {modelOf(chatAgent)}</span>}
                    </span>
                  </>
                )}
              </li>
            </ul>
          </Section>
        </>
      )}
    </div>
  )
}

type Usage = Pick<StepUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'>

/** 几个节点的用量加起来 */
function sumUsage(steps: TaskStep[]): Usage {
  const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  for (const s of steps) if (s.usage) for (const k of Object.keys(u) as (keyof Usage)[]) u[k] += s.usage[k] ?? 0
  return u
}

function sumChanges(steps: TaskStep[]) {
  const out: FileChange[] = []
  for (const s of steps) mergeChanges(out, s.changes ?? [])
  return out
}

/** 一个 Agent（或节点）的上下文占用；live 是正在输出时的速度 */
function ContextRow({
  agent,
  label,
  u,
  live,
}: {
  agent?: { name: string; icon: string; cli: string }
  label?: string
  u: { context: number; window: number; model: string }
  live?: { tps: number; outputTokens: number; genMs: number }
}) {
  const p = Math.min(100, (u.context / u.window) * 100)
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs">
        {agent && <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />}
        <span className="min-w-0 flex-1 truncate text-fg" title={label}>
          {label ?? agent?.name ?? t('已删除的 Agent')}
        </span>
        <span className="font-mono text-subtle">
          {fmtTokens(u.context)} / {fmtTokens(u.window)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-field">
        <span
          className={cn('block h-full rounded-full', p > 80 ? 'bg-warning' : 'bg-accent')}
          style={{ width: `${Math.max(p, 1)}%` }}
        />
      </div>
      <span className="flex flex-wrap gap-x-1.5 font-mono text-[11px] text-subtle">
        <span>
          {u.model || t('默认模型')} · {t('已使用 {n}%', { n: p.toFixed(1) })}
        </span>
        {live && live.tps > 0 ? (
          <span className="text-accent">· {live.tps.toFixed(1)} token/s</span>
        ) : (
          live &&
          live.genMs > 3000 &&
          live.outputTokens > 0 && (
            <span title={t('输出 token ÷ 生成用时')}>
              · {t('平均 {n} token/s', { n: ((live.outputTokens / live.genMs) * 1000).toFixed(1) })}
            </span>
          )
        )}
      </span>
    </li>
  )
}

/** Token 用量：总数、输入 / 输出、缓存命中和命中率、费用 */
function TokenUsage({ usage: u, tps, extra }: { usage: Usage; tps: number; extra?: React.ReactNode }) {
  const total = u.inputTokens + u.outputTokens
  const rate = u.inputTokens > 0 ? (u.cacheReadTokens ?? 0) / u.inputTokens : 0
  const rows: [string, string, string?][] = [
    [t('输入'), fmtTokens(u.inputTokens)],
    [t('输出'), fmtTokens(u.outputTokens)],
    [t('缓存命中'), fmtTokens(u.cacheReadTokens ?? 0)],
    [t('缓存写入'), fmtTokens(u.cacheWriteTokens ?? 0)],
    [t('未命中缓存'), fmtTokens(Math.max(0, u.inputTokens - (u.cacheReadTokens ?? 0)))],
  ]
  return (
    <Section
      title={t('Token 用量')}
      extra={tps > 0 ? <span className="font-mono text-accent">{tps.toFixed(1)} token/s</span> : extra}
    >
      {total === 0 ? (
        <p className="text-xs text-subtle">{t('CLI 报告用量后会显示在这里。')}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-lg font-semibold tabular-nums">{fmtTokens(total)}</span>
            <span className="text-xs text-subtle">{t('累计 token')}</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-xs">
              {/* 所有调用累加：读缓存的输入 ÷ 全部输入，不是最后一次请求的 */}
              <span className="text-muted">{t('缓存命中率 · 累计')}</span>
              <span
                className="font-mono font-medium tabular-nums"
                title={t('读缓存 {hit} / 输入 {input}', {
                  hit: fmtTokens(u.cacheReadTokens ?? 0),
                  input: fmtTokens(u.inputTokens),
                })}
              >
                {(rate * 100).toFixed(1)}%
              </span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-field"
              role="img"
              aria-label={t('缓存命中率 {n}%', { n: (rate * 100).toFixed(1) })}
            >
              <span className="block h-full rounded-full bg-success" style={{ width: `${rate * 100}%` }} />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="text-subtle">{k}</dt>
                <dd className="font-mono text-muted tabular-nums">{v}</dd>
              </div>
            ))}
            {u.costUsd > 0 && (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-subtle">{t('费用')}</dt>
                <dd className="font-mono text-muted tabular-nums">${u.costUsd.toFixed(3)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </Section>
  )
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
            <span className="text-[11px] text-subtle">
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
