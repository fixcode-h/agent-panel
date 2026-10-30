import { useEffect, useMemo, useState } from 'react'
import { getCli } from '@shared/clis'
import { contextBreakdown } from '@shared/context-breakdown'
import { t } from '@shared/i18n'
import type { AgentUsage, SessionInfo, Task } from '@shared/schema'
import { agentRun, cliSettings, defaultCli } from '@shared/settings'
import { timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { ContextHead, ContextLegend } from './ContextUsage'

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
 * 会话栏「上下文」那一块的取数：当前答话的角色、它用的 CLI、对话目录信息和细分。
 * 会话栏和输入框下的上下文小块（会话栏收起时）共用，两处口径一致
 */
export function useSessionContext(task: Task) {
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
  return { cur, agent, cli, def, info, data }
}

/** 上下文细分的正文：总占用、分色条、各块明细，最后一行写清是谁、哪个模型、细分是报的还是估的 */
export function SessionContextBody({ ctx }: { ctx: ReturnType<typeof useSessionContext> }) {
  const { cur, agent, cli, def, data } = ctx
  if (!data) return <p className="text-xs text-subtle">{t('Agent 回复后显示上下文占用')}</p>
  return (
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
  )
}
