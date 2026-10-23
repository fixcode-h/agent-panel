import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Coins,
  FolderOpen,
  Gauge,
  GitBranch,
  Loader2,
  MessageSquare,
  Shrink,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { getCli } from '@shared/clis'
import { agentRun, cliSettings, defaultCli, defaultSettings } from '@shared/settings'
import type { StepUsage, Task, TaskStep } from '@shared/schema'
import { topSteps } from '@shared/flow'
import { fmtTokens, stepLabel, tokenGroups, tpsNow } from '@/lib/tasks'
import { useRunUsage } from '@/lib/useRunUsage'
import { cacheHitRate } from '@shared/task-export'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { useDirInfo, refreshDirInfo } from '@/components/projects/DirPicker'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { LimitBars, hasLimits, useCliLimits } from '@/components/settings/CliLimits'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { withTaskModel } from '@shared/task'
import { WorktreeMark, WorktreeSection, useWorktrees, worktreeKey } from './Worktrees'

/** 输入框下面那几个小块的共同样式 */
const chip =
  'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.6875rem] leading-none text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel data-[state=open]:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-subtle'

type Usage = Pick<StepUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'costUsd'>
type Live = { tps: number; lastTps?: number; outputTokens: number; genMs: number }
/** 一行上下文：谁、用的是哪个模型、占了多少 */
type ContextLine = {
  key: string
  name?: string
  icon?: string
  cli?: string
  u: { context: number; window: number; model: string }
  live?: Live
}

function sumUsage(steps: TaskStep[]): Usage {
  const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }
  for (const s of steps) if (s.usage) for (const k of Object.keys(u) as (keyof Usage)[]) u[k] += s.usage[k] ?? 0
  return u
}

/**
 * 输入框下面的信息条：上下文占用、Token 用量、环境（目录、分支、工作流或 Agent）。
 * 一行放不下时换行，细节收在点开的浮层里，不占地方。
 */
export function TaskMeta({
  task,
  projectName,
  projectPath,
  workflowName,
  node,
  onTask,
}: {
  task: Task
  projectName?: string
  projectPath?: string
  /** 工作流任务的名字；对话任务不传 */
  workflowName?: string
  /** 流程图里选中的节点：上下文和用量只看这个节点 */
  node?: TaskStep
  /** 压缩上下文之后把新的任务状态交回页面 */
  onTask: (task: Task) => void
}) {
  const { agents } = useData()
  const byId = new Map(agents.map((a) => [a.id, a]))
  const scope = node ? [node, ...task.steps.filter((s) => s.id.startsWith(node.id + '/'))] : undefined
  const lines = contextLines(task, scope, node, byId)
  // 没有上下文的 Agent（例如对话还没开始）就不显示这一块
  return (
    <div className="mx-auto mt-2 flex max-w-(--content-w) flex-wrap items-center gap-x-1 gap-y-1 px-1">
      {lines.length > 0 && <ContextChip lines={lines} />}
      <TokenChip task={task} scope={scope} />
      <EnvChip
        task={task}
        projectName={projectName}
        projectPath={projectPath}
        workflowName={workflowName}
        onTask={onTask}
      />
    </div>
  )
}

/** 上下文按节点一行：流程图里选了节点只看它，工作流按主流程节点，对话按 Agent */
function contextLines(
  task: Task,
  scope: TaskStep[] | undefined,
  node: TaskStep | undefined,
  byId: Map<string, { name: string; icon: string; cli: string }>,
): ContextLine[] {
  const live = (id: string): Live | undefined => task.usage.agents[id]
  if (scope)
    return scope
      .filter((s) => s.usage?.window)
      .map((s) => {
        const a = byId.get(s.agentId)
        return {
          key: s.id,
          name: s === node ? (a?.name ?? t('已删除的角色')) : stepLabel(s),
          icon: a?.icon,
          cli: a?.cli,
          u: s.usage!,
          live: live(s.agentId),
        }
      })
  if (task.mode === 'workflow') {
    const rows: ContextLine[] = []
    for (const st of topSteps(task)) {
      // 调用流程的节点自己不启动 CLI，看它里面最近跑的那个
      const own = st.usage?.window ? st : undefined
      const sub = task.steps
        .filter((s) => s.id.startsWith(st.id + '/') && s.usage?.window)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
      const src = own ?? sub
      if (!src) continue
      const a = byId.get(src.agentId)
      rows.push({ key: st.id, name: st.title, icon: a?.icon, cli: a?.cli, u: src.usage!, live: live(src.agentId) })
    }
    return rows
  }
  return Object.entries(task.usage.agents).map(([id, u]) => {
    const a = byId.get(id)
    return { key: id, name: a?.name ?? t('已删除的角色'), icon: a?.icon, cli: a?.cli, u, live: u }
  })
}

/** 上下文占用：上面显示占用最高的那个，点开列出全部 */
function ContextChip({ lines }: { lines: ContextLine[] }) {
  const top = [...lines].sort((a, b) => b.u.context / b.u.window - a.u.context / a.u.window)[0]
  const p = Math.min(100, (top.u.context / top.u.window) * 100)
  return (
    <Popover>
      <PopoverTrigger className={chip} title={t('上下文占用')} aria-label={t('上下文')}>
        <Gauge className="h-3.5 w-3.5" />
        <span className="font-mono">
          {fmtTokens(top.u.context)} / {fmtTokens(top.u.window)}
        </span>
        <span className="h-1 w-8 overflow-hidden rounded-full bg-field">
          <span
            className={cn('block h-full rounded-full', p > 80 ? 'bg-warning' : 'bg-accent')}
            style={{ width: `${Math.max(p, 2)}%` }}
          />
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-[min(440px,calc(100vw-24px))]">
        <ul className="flex flex-col gap-3 p-2.5">
          {lines.map((l) => (
            <ContextRow key={l.key} line={l} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** 一个 Agent（或节点）的上下文占用；live 是它自己的用量记录，速度只显示正在输出的 */
function ContextRow({ line }: { line: ContextLine }) {
  const { name, icon, cli, u, live } = line
  const p = Math.min(100, (u.context / u.window) * 100)
  const tps = live?.tps ?? 0
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs">
        {icon && <AgentAvatar icon={icon} cli={cli ?? ''} size="xs" />}
        <span className="min-w-0 flex-1 truncate text-fg" title={name}>
          {name ?? t('已删除的角色')}
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
      <span className="flex flex-wrap gap-x-1.5 font-mono text-[0.6875rem] text-subtle">
        <span>
          {u.model || t('默认模型')} · {t('已使用 {n}%', { n: p.toFixed(1) })}
        </span>
        {live && (
          <span className={cn(tps > 0 && 'text-accent')} title={t('实时输出速度')}>
            · {tps > 0 ? `${tps.toFixed(1)} token/s` : t('空闲')}
          </span>
        )}
      </span>
    </li>
  )
}

/** Token 用量：总数、速度、命中率；点开看输入、输出、缓存命中和费用 */
function TokenChip({ task, scope }: { task: Task; scope?: TaskStep[] }) {
  // 没选节点时是整个运行（父对话 + 所有子对话 + 派出的子任务）：子对话不在任务列表里，只能问服务端
  const run = useRunUsage(task, !scope)
  const u = scope ? sumUsage(scope) : run.total
  const tps = scope ? tpsNow(task, [...new Set(scope.map((s) => s.agentId))]) : run.runTps
  // 有子对话或子任务时才分组：没有时浮层和以前一样，不出现「子任务 0」这种噪音行
  const groups = scope ? [] : tokenGroups(run)
  const total = u.inputTokens + u.outputTokens
  if (!total) return null
  const rate = cacheHitRate(u)
  const rows: [string, string][] = [
    [t('输入'), fmtTokens(u.inputTokens)],
    [t('输出'), fmtTokens(u.outputTokens)],
    [t('缓存命中'), fmtTokens(u.cacheReadTokens ?? 0)],
  ]
  const label = scope ? t('累计 token') : t('整个运行')
  const groupLabel = { own: t('本对话'), sub: t('子任务与子对话') }
  return (
    <Popover>
      <PopoverTrigger className={chip} title={t('Token 用量')}>
        <Coins className="h-3.5 w-3.5" />
        <span className="font-mono">{fmtTokens(total)}</span>
        {tps > 0 && <span className="font-mono text-accent">{tps.toFixed(1)} token/s</span>}
        {u.inputTokens > 0 && (
          <span className={cn('font-mono', rate >= 0.5 && 'text-success')}>
            {t('命中 {n}%', { n: (rate * 100).toFixed(0) })}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-24px))]">
        <div className="flex flex-col gap-2 p-2.5">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-base font-semibold tabular-nums">{fmtTokens(total)}</span>
            <span className="text-xs text-subtle">{label}</span>
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
                {/* 这是 CLI 自己上报的美元金额，不是按计价模型折算的费用，标签里写清楚免得和用量统计的「费用」混起来 */}
                <dt className="text-subtle">{t('CLI 上报费用')}</dt>
                <dd className="font-mono text-muted tabular-nums">${u.costUsd.toFixed(3)}</dd>
              </div>
            )}
          </dl>
          {groups.length > 0 && (
            <dl className="flex flex-col gap-1.5 border-t pt-2 text-xs">
              {groups.map((g) => (
                <div key={g.key} className="flex items-baseline gap-2">
                  <dt className="text-subtle">{groupLabel[g.key]}</dt>
                  <dd className="ml-auto font-mono text-muted tabular-nums">{fmtTokens(g.tokens)}</dd>
                  {g.tps > 0 ? (
                    <dd className="min-w-[5.5rem] whitespace-nowrap text-right font-mono text-accent tabular-nums">
                      {g.tps.toFixed(1)} token/s
                    </dd>
                  ) : (
                    // 停下的部分写「空闲」：不拿这一轮最后一次的速度冒充实时
                    <dd className="min-w-[5.5rem] whitespace-nowrap text-right font-mono text-subtle">{t('空闲')}</dd>
                  )}
                </div>
              ))}
            </dl>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 环境：目录、分支（可以切）、工作流或对话用的 Agent，还有打开了「显示额度」的 CLI */
function EnvChip({
  task,
  projectName,
  projectPath,
  workflowName,
  onTask,
}: {
  task: Task
  projectName?: string
  projectPath?: string
  workflowName?: string
  onTask: (task: Task) => void
}) {
  const { agents, settings } = useData()
  const { modelOf } = useAgentView()
  const dir = useDirInfo(projectPath ?? '')
  const idle = task.status !== 'running'
  const s = settings ?? defaultSettings()
  const found = agents.find((a) => a.id === task.agentId)
  // 不用角色的对话按 CLI 显示：名字和模型跟着对话现在用的 CLI
  const byCli = task.mode === 'chat' && !task.agentId
  const chatAgent = found && withTaskModel(found, task)
  const name =
    task.mode === 'workflow'
      ? workflowName
      : byCli
        ? getCli(task.cli || defaultCli(s))?.name
        : (found?.name ?? t('已删除的角色'))
  // 用到的 CLI 里打开了「显示额度」的，每个显示一组
  const ids = new Set<string>()
  for (const id of [task.agentId, ...Object.keys(task.usage.agents)]) {
    const a = agents.find((x) => x.id === id)
    if (a) ids.add(agentRun(withTaskModel(a, task), s).cli)
  }
  const limited = [...ids].filter((c) => hasLimits(c) && cliSettings(s, c).showLimits)
  // 在独立分支里：分支那块写「开出的分支 → 独立分支」，后面标合没合回去
  const wt = task.worktree?.state === 'active' ? task.worktree : null
  const own = useWorktrees(task.id, worktreeKey(task), !!wt)?.find((x) => x.taskId === task.id)
  return (
    <Popover>
      <PopoverTrigger
        className={cn(chip, 'min-w-0 max-w-[min(480px,70vw)]')}
        title={projectPath || t('环境')}
        aria-label={t('环境')}
      >
        {projectPath ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate">{projectName || projectPath || t('聊天')}</span>
        {wt ? (
          <span className="flex min-w-0 items-center gap-1 font-mono">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="shrink-0">{wt.baseBranch || dir?.gitBranch || 'HEAD'}</span>
            <ArrowRight className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{wt.branch}</span>
            {own && <WorktreeMark item={own} className="h-3 w-3" />}
          </span>
        ) : (
          dir?.gitBranch && (
            <span className="flex shrink-0 items-center gap-1 font-mono">
              <GitBranch className="h-3 w-3" />
              {dir.gitBranch}
            </span>
          )
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[min(440px,calc(100vw-24px))]">
        <div className="flex flex-col gap-2.5 p-2.5 text-xs text-muted">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
            {projectPath ? (
              <span className="min-w-0 truncate font-mono" title={projectPath}>
                {projectPath}
              </span>
            ) : (
              <span>{t('聊天，不在任何项目里')}</span>
            )}
          </div>
          {dir?.gitBranch && (
            <BranchRow key={projectPath} path={projectPath ?? ''} branch={dir.gitBranch} disabled={!idle} />
          )}
          {projectPath && <WorktreeSection task={task} />}
          <div className="flex items-center gap-2">
            {task.mode === 'workflow' ? (
              <>
                <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="truncate">{t('工作流：{name}', { name: name || t('已删除的工作流') })}</span>
              </>
            ) : (
              <>
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="truncate">
                  {t('对话：{name}', { name: name || t('已删除的角色') })}
                  {chatAgent && <span className="font-mono text-subtle"> · {modelOf(chatAgent)}</span>}
                </span>
              </>
            )}
          </div>
          {limited.map((c) => (
            <LimitRow key={c} cli={c} named={limited.length > 1} />
          ))}
          {task.mode === 'chat' && !task.simulated && idle && Object.keys(task.sessions).length > 0 && (
            <button
              type="button"
              disabled={!idle}
              title={t('让 Agent 把之前的对话压缩成摘要，腾出上下文')}
              onClick={async () => {
                try {
                  onTask(await api.compactTask(task.id))
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
              className="-mx-1 flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-muted transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted"
            >
              <Shrink className="h-3.5 w-3.5 shrink-0" />
              {t('压缩上下文')}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LimitRow({ cli, named }: { cli: string; named: boolean }) {
  const { data, error } = useCliLimits(cli, true)
  return (
    <div className="flex flex-col gap-1.5 border-t pt-2">
      {named && <p className="text-[0.75rem] font-medium text-fg">{getCli(cli)?.name}</p>}
      {data?.windows.length ? (
        <LimitBars data={data} compact />
      ) : (
        <p className="text-subtle">
          {error
            ? t('读取失败：{error}', { error })
            : getCli(cli)?.limits === 'push'
              ? t('执行后会显示')
              : t('读取中…')}
        </p>
      )}
    </div>
  )
}

/** 环境里的分支行：点开列出本地分支，选中就切过去 */
function BranchRow({ path, branch, disabled }: { path: string; branch: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState(branch)
  const [list, setList] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  // 每次展开都重新读一次：切完分支后顺序（按最近提交）也跟着变
  useEffect(() => {
    if (!open) return
    let alive = true
    setError('')
    setList(null)
    api
      .dirBranches(path)
      .then((r) => {
        if (!alive) return
        setList(r.branches)
        if (r.current) setCurrent(r.current)
      })
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [open, path])

  const pick = async (name: string) => {
    if (name === current || busy) return
    setBusy(name)
    try {
      const info = await api.checkoutBranch(path, name)
      setCurrent(info.gitBranch ?? name)
      // 项目标题、目录检测等也换成新分支
      refreshDirInfo()
      toast.success(t('已切换到分支 {branch}', { branch: name }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        disabled={disabled}
        title={disabled ? t('任务执行中，不能切换分支') : t('切换分支')}
        aria-label={t('切换分支')}
        className="-mx-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{current}</span>
        {!disabled && <ChevronDown className="h-3 w-3 shrink-0 text-subtle" />}
      </PopoverTrigger>
      {/* 宽高跟着分支名走，分支多时在列表里滚动 */}
      <PopoverContent className="w-max max-w-[min(420px,calc(100vw-24px))] min-w-[200px]">
        <div className="max-h-72 overflow-y-auto">
          {!list && !error && <p className="px-2.5 py-2 text-xs text-subtle">{t('正在读取分支…')}</p>}
          {error && <p className="px-2.5 py-2 text-xs text-danger">{error}</p>}
          {list?.length === 0 && <p className="px-2.5 py-2 text-xs text-subtle">{t('没有其他分支')}</p>}
          {list?.map((b) => (
            <PopoverClose key={b} className={cn(menuItem, 'gap-2 py-1.5')} onClick={() => void pick(b)}>
              <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem]">{b}</span>
              {b === current && <Check className="h-4 w-4 shrink-0 text-accent" />}
            </PopoverClose>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
