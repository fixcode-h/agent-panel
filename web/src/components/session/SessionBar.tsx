import { useEffect, useMemo, useState } from 'react'
import { BookMarked, FilePlus2, FileText, GitBranch, GitCompareArrows, Monitor, Settings, Split } from 'lucide-react'
import { getCli } from '@shared/clis'
import { contextBreakdown } from '@shared/context-breakdown'
import { t } from '@shared/i18n'
import type { AgentUsage, SessionInfo, Task } from '@shared/schema'
import { agentRun, cliSettings, defaultCli } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { ContextHead, ContextLegend } from './ContextUsage'
import { SessionCard, SessionRow } from './SessionCard'

/** 「更改」里直接列出的文件数，多的点「查看全部」去改动页 */
const CHANGES_SHOWN = 5

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
 * 对话页右栏的会话栏（照 Claude Code）：环境、上下文细分、输出内容（这个对话新建的文件）、更改（改过的文件）。
 * 上下文的总数来自 Agent 报的用量，细分里面板交给它的部分按字数换算，CLI 自己的部分是 CLI 定义里的估计值
 */
export function SessionBar({
  task,
  projectName,
  onSettings,
  onOpenFile,
  onDiff,
  onAllChanges,
}: {
  task: Task
  projectName?: string
  /** 打开对话设置；子对话、工作流任务没有 */
  onSettings?: () => void
  onOpenFile: (path: string) => void
  onDiff: (path: string) => void
  onAllChanges: () => void
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
          })
        : null,
    [cur?.usage, def, info, settings, cli],
  )

  const changes = task.changes
  const worktree = task.worktree
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain p-3" data-session-bar>
      <SessionCard id="env" title={t('环境')}>
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
              {!cur?.usage.parts && ` · ${t('下一轮开始后才能细分面板工具')}`}
            </p>
          </div>
        ) : (
          <p className="text-xs text-subtle">{t('Agent 回复后显示上下文占用')}</p>
        )}
      </SessionCard>

      <SessionCard id="outputs" title={t('输出内容')}>
        {info?.outputs.length ? (
          info.outputs.map((p) => (
            <SessionRow
              key={p}
              icon={<FilePlus2 />}
              title={p}
              onClick={() => onOpenFile(p)}
              className="font-mono text-xs"
            >
              {p.split('/').pop()}
              {p.includes('/') && <span className="ml-1.5 text-subtle">{p.slice(0, p.lastIndexOf('/'))}</span>}
            </SessionRow>
          ))
        ) : (
          <p className="text-xs text-subtle">{t('这个对话还没有新建文件')}</p>
        )}
      </SessionCard>

      <SessionCard
        id="changes"
        title={t('更改')}
        trailing={
          changes.length > 0 && (
            <span className="font-mono text-xs">
              <span className="text-success">+{changes.reduce((n, c) => n + c.add, 0)}</span>{' '}
              <span className="text-danger">-{changes.reduce((n, c) => n + c.del, 0)}</span>
            </span>
          )
        }
      >
        {changes.length ? (
          <>
            {changes.slice(0, CHANGES_SHOWN).map((c) => (
              <SessionRow
                key={c.path}
                icon={<FileText />}
                title={t('查看「{path}」的改动', { path: c.path })}
                onClick={() => onDiff(c.path)}
                trailing={
                  <span className="shrink-0 pr-1 font-mono text-[0.6875rem]">
                    <span className="text-success">+{c.add}</span>
                    <span className={cn('ml-1 text-danger', !c.del && 'invisible')}>-{c.del}</span>
                  </span>
                }
                className="font-mono text-xs"
              >
                {c.path}
              </SessionRow>
            ))}
            <SessionRow icon={<GitCompareArrows />} onClick={onAllChanges} className="text-muted">
              {changes.length > CHANGES_SHOWN
                ? t('查看全部 {n} 个文件的改动', { n: changes.length })
                : t('在改动页查看')}
            </SessionRow>
          </>
        ) : (
          <p className="text-xs text-subtle">{t('还没有改动文件。')}</p>
        )}
      </SessionCard>
    </div>
  )
}
