import type { ReactNode } from 'react'
import { BookMarked, GitBranch, Monitor, Settings, Split } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { IconButton } from '@/components/ui/icon-button'
import { TokenUsage } from '@/components/tasks/TaskMeta'
import { ToolStats } from '@/components/tasks/ToolFailuresChip'
import { SessionCard, SessionRow } from './SessionCard'
import { SessionContextBody, useSessionContext } from './SessionContext'
import { StatusCard } from './StatusCard'
import type { ChildEntry } from '@shared/task'

/**
 * 对话页右栏的会话栏（照 Claude Code）：环境、上下文细分、状态（为什么停在这里）、Token 用量、工具调用（改动在右侧文件栏的改动页看）。
 * 上下文的总数来自 Agent 报的用量，细分里面板交给它的部分按字数换算，CLI 自己的部分是 CLI 定义里的估计值
 */
export function SessionBar({
  task,
  projectName,
  onSettings,
  env,
  onTask,
  kids,
}: {
  task: Task
  /** 名下的子对话（/children 的摘要）：「状态」那句话按它判断在等什么，子对话本身不在这里列 */
  kids?: (ChildEntry & { title: string })[]
  /** 压缩会话后把新的任务状态交回页面 */
  onTask?: (task: Task) => void
  projectName?: string
  /** 打开对话设置；子对话、工作流任务没有 */
  onSettings?: () => void
  /** 「环境」标题行右端的入口：切分支、独立分支、CLI 额度（输入框下面原来那块收到这里） */
  env?: ReactNode
}) {
  const ctx = useSessionContext(task)
  const { def, info } = ctx

  const worktree = task.worktree
  return (
    <div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain" data-session-bar>
      <SessionCard id="env" title={t('环境')} trailing={env}>
        <SessionRow
          icon={worktree ? <Split /> : <Monitor />}
          title={info?.dir}
          trailing={onSettings && <IconButton size="xs" icon={Settings} label={t('对话设置')} onClick={onSettings} />}
        >
          {worktree ? t('本机 · 独立分支') : t('本机')}
          {def && <span className="text-subtle"> · {def.name}</span>}
        </SessionRow>
        {/* 仓库和分支合成一行（仓库 · 分支）；不是 git 仓库就整行不显示 */}
        {(worktree || info?.isGit) && (
          <SessionRow
            icon={<BookMarked />}
            title={[info?.dir ?? worktree?.path, worktree?.branch || info?.branch].filter(Boolean).join(' · ')}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{info?.repo || projectName || '…'}</span>
              <span aria-hidden className="shrink-0 text-subtle">
                ·
              </span>
              <GitBranch className="!h-3.5 !w-3.5 shrink-0 text-muted" />
              <span className="max-w-[50%] min-w-0 shrink-0 truncate font-mono text-body">
                {worktree?.branch || info?.branch || '…'}
              </span>
            </span>
          </SessionRow>
        )}
      </SessionCard>

      <SessionCard id="context" title={t('上下文')}>
        <SessionContextBody task={task} ctx={ctx} onTask={onTask} />
      </SessionCard>

      {/* 「状态」放在「上下文」下面（用户要求）：先看上下文用得怎么样，再看这轮在等什么。
          子对话不在右栏列（ADR 0034）：状态和往来的信都在输入框上方的子对话面板里，完整时间线在对话菜单「父子往来记录」 */}
      <StatusCard task={task} kids={kids} />

      <SessionCard id="tokens" title={t('Token 用量')}>
        <TokenUsage task={task} />
      </SessionCard>

      <SessionCard id="tools" title={t('工具调用')}>
        <ToolStats task={task} />
      </SessionCard>
    </div>
  )
}
