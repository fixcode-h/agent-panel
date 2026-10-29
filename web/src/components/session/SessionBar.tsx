import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookMarked, GitBranch, Monitor, Settings, Split } from 'lucide-react'
import { getCli } from '@shared/clis'
import { contextBreakdown } from '@shared/context-breakdown'
import { t } from '@shared/i18n'
import type { AgentUsage, SessionInfo, Task } from '@shared/schema'
import { agentRun, cliSettings, defaultCli } from '@shared/settings'
import { timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { IconButton } from '@/components/ui/icon-button'
import { TokenUsage } from '@/components/tasks/TaskMeta'
import { ToolStats } from '@/components/tasks/ToolFailuresChip'
import { ContextHead, ContextLegend } from './ContextUsage'
import { SessionCard, SessionRow } from './SessionCard'

/**
 * 这个对话现在是谁在答话、它的上下文用量：对话按最后一条回复的角色（和输入框下的上下文圆环同一口径），
 * 工作流按最近开始的、报过窗口的节点
 */
export function sessionUsage(task: Task): { agentId: string; usage: AgentUsage } | null {
  const agents = task.usage.agents
  let id = ''
  if (task.mode === 'workflow') {
    id =
      [...task.steps]
        .filter((s) => s.usage?.window && agents[s.agentId])
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.agentId ?? ''
  } else {
    id = [...task.messages].reverse().find((m) => m.agentId && agents[m.agentId])?.agentId ?? ''
  }
  if (!id) id = Object.keys(agents).at(-1) ?? ''
  return id && agents[id] ? { agentId: id, usage: agents[id] } : null
}

/**
 * 对话页右栏的会话栏（照 Claude Code）：环境、上下文细分、Token 用量、工具调用（改动在右侧文件栏的改动页看）。
 * 上下文的总数来自 Agent 报的用量，细分里面板交给它的部分按字数换算，CLI 自己的部分是 CLI 定义里的估计值
 */
export function SessionBar({
  task,
  projectName,
  onSettings,
  env,
}: {
  task: Task
  projectName?: string
  /** 打开对话设置；子对话、工作流任务没有 */
  onSettings?: () => void
  /** 「环境」标题行右端的入口：切分支、独立分支、CLI 额度（输入框下面原来那块收到这里） */
  env?: ReactNode
}) {
  const { agents, settings } = useData()
  const cur = sessionUsage(task)
  const agent = cur ? agents.find((a) => a.id === cur.agentId) : undefined
  const cli =
    cur?.usage.parts?.cli ||
    (agent && settings ? agentRun(agent, settings).cli : '') ||
    task.sessionCli ||
    (settings ? defaultCli(settings) : '')
  const def = getCli(cli)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  // 改动变了（新建了文件）、跑完、换了 CLI 时重读；执行中每秒都在推任务，不能跟着读
  const stamp = task.changes.map((c) => c.path).join('|')
  const ended = task.status !== 'running' || !task.working
  useEffect(() => {
    let alive = true
    api
      .taskSession(task.id, cli)
      .then((x) => alive && setInfo(x))
      .catch(() => alive && setInfo(null))
    return () => {
      alive = false
    }
  }, [task.id, cli, stamp, ended])

  const data = useMemo(
    () =>
      cur?.usage.window
        ? contextBreakdown({
            used: cur.usage.context,
            window: cur.usage.window,
            base: def?.context,
            parts: cur.usage.parts,
            files: info ?? undefined,
            autoCompactPct: settings ? cliSettings(settings, cli).autoCompact : 0,
            snapshot: cur.usage.snapshot,
          })
        : null,
    [cur?.usage, def, info, settings, cli],
  )

  const worktree = task.worktree
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain p-3" data-session-bar>
      <SessionCard id="env" title={t('环境')} trailing={env}>
        <SessionRow
          icon={worktree ? <Split /> : <Monitor />}
          title={info?.dir}
          trailing={onSettings && <IconButton size="xs" icon={Settings} label={t('对话设置')} onClick={onSettings} />}
        >
          {worktree ? t('本机 · 独立分支') : t('本机')}
          {def && <span className="text-subtle"> · {def.name}</span>}
        </SessionRow>
        <SessionRow icon={<BookMarked />} title={info?.dir}>
          {info?.repo || projectName || t('没有项目目录')}
        </SessionRow>
        <SessionRow icon={<GitBranch />} title={worktree?.path}>
          <span className="font-mono text-[0.8125rem]">
            {worktree?.branch || info?.branch || (info && !info.isGit ? t('不是 git 仓库') : '…')}
          </span>
        </SessionRow>
      </SessionCard>

      <SessionCard id="context" title={t('上下文')}>
        {data ? (
          <div className="flex flex-col gap-3">
            <ContextHead data={data} caption={cur?.usage.model} />
            <ContextLegend data={data} />
            <p className="text-[0.6875rem] leading-relaxed text-subtle">
              {[agent?.name, cur?.usage.model].filter(Boolean).join(' · ')}
              {/* 细分从哪来：Agent 自己报的写上报的时间；估的说明是估的，免得当成精确值 */}
              {data.source === 'reported'
                ? ` · ${t('{cli} 报的细分，{ago}更新', { cli: def?.name ?? cli, ago: timeAgo(data.at ?? '') })}`
                : ` · ${t('各块是按字数和版本量级估的，总数是 Agent 报的')}`}
              {data.source === 'estimated' && !cur?.usage.parts && ` · ${t('下一轮开始后才能细分面板工具')}`}
            </p>
          </div>
        ) : (
          <p className="text-xs text-subtle">{t('Agent 回复后显示上下文占用')}</p>
        )}
      </SessionCard>

      <SessionCard id="tokens" title={t('Token 用量')}>
        <TokenUsage task={task} />
      </SessionCard>

      <SessionCard id="tools" title={t('工具调用')}>
        <ToolStats task={task} />
      </SessionCard>
    </div>
  )
}
