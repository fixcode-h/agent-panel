import { useEffect, useMemo, useState } from 'react'
import { Loader2, Shrink } from 'lucide-react'
import { getCli } from '@shared/clis'
import { contextBreakdown } from '@shared/context-breakdown'
import { t } from '@shared/i18n'
import type { AgentUsage, SessionInfo, Task } from '@shared/schema'
import { agentRun, cliSettings, defaultCli } from '@shared/settings'
import { timeAgo } from '@shared/task'
import { api } from '@/lib/api'
import { fmtTokens } from '@/lib/tasks'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useData } from '@/lib/data'
import type { ContextBreakdown } from '@shared/context-breakdown'
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

/**
 * 「压缩会话」能不能点：null 是不放按钮（不是对话、模拟、导入的、还没有会话）。
 * busy 是 Agent 正在回复：现有的 CLI 都没法在一轮回复中途压缩（Claude Code、Codex 要等这一轮结束，
 * Pi 的压缩会先把正在写的回复中止掉），所以要等这一轮结束；停在等下一句时可以点，服务端先关掉等着的进程再压缩
 */
export function compactState(task: Task): null | { busy: boolean } {
  if (task.mode !== 'chat' || task.simulated || task.imported) return null
  if (!Object.keys(task.sessions).length && !task.rewind) return null
  return { busy: !!task.working }
}

/** 细分底部一行（照 Claude Code）：离自动压缩还剩多少，右边是「压缩会话」 */
function CompactFooter({ task, data, onTask }: { task: Task; data: ContextBreakdown; onTask?: (t: Task) => void }) {
  const [sending, setSending] = useState(false)
  const st = compactState(task)
  const free = data.rows.find((r) => r.key === 'free')?.tokens ?? Math.max(0, data.window - data.used)
  // 有自动压缩余量这一块才说「距自动压缩」；没有时（CLI 不自动压缩）只说还剩多少
  const auto = data.rows.some((r) => r.key === 'buffer')
  return (
    <div className="flex items-center gap-2 border-t pt-2.5" data-compact-footer>
      <span className="min-w-0 flex-1 truncate text-xs text-muted">
        {auto ? t('距自动压缩还剩 {n}', { n: fmtTokens(free) }) : t('上下文还剩 {n}', { n: fmtTokens(free) })}
      </span>
      {st && (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 shrink-0 rounded-md px-2 text-xs"
          disabled={st.busy || sending}
          title={st.busy ? t('Agent 正在回复，这一轮结束后才能压缩') : t('让 Agent 把之前的对话压缩成摘要，腾出上下文')}
          onClick={async () => {
            setSending(true)
            try {
              const next = await api.compactTask(task.id)
              onTask?.(next)
            } catch (e) {
              toast.error((e as Error).message)
            } finally {
              setSending(false)
            }
          }}
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shrink className="h-3.5 w-3.5" />}
          {t('压缩会话')}
        </Button>
      )}
    </div>
  )
}

/** 上下文细分的正文：总占用、分色条、各块明细，写清是谁、哪个模型、细分是报的还是估的，最后是压缩那一行 */
export function SessionContextBody({
  task,
  ctx,
  onTask,
}: {
  task: Task
  ctx: ReturnType<typeof useSessionContext>
  /** 点了压缩后把新的任务状态交回页面；不传就等推送 */
  onTask?: (t: Task) => void
}) {
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
      <CompactFooter task={task} data={data} onTask={onTask} />
    </div>
  )
}
