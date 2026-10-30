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
import { CollabCard } from './CollabCard'
import type { ChildEntry } from '@shared/task'

/**
 * 对话页右栏的会话栏（照 Claude Code）：状态（为什么停在这里）、父子协作、环境、上下文细分、Token 用量、工具调用（改动在右侧文件栏的改动页看）。
 * 上下文的总数来自 Agent 报的用量，细分里面板交给它的部分按字数换算，CLI 自己的部分是 CLI 定义里的估计值
 */
export function SessionBar({
  task,
  projectName,
  onSettings,
  env,
  onTask,
  kids,
  onOpenChild,
}: {
  task: Task
  /** 名下的子对话（/children 的摘要）：「状态」里列出在等的那几个 */
  kids?: (ChildEntry & { title: string })[]
  /** 点「状态」里的子对话：在右栏打开它 */
  onOpenChild?: (id: string) => void
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
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain p-3" data-session-bar>
      <StatusCard task={task} kids={kids} onOpenChild={onOpenChild} />
      {(task.parentTaskId || !!kids?.length) && (
        <CollabCard
          task={task}
          kidsStamp={(kids ?? []).map((k) => `${k.id}:${k.status}:${k.working}:${k.turnDoneAt ?? ''}`).join('|')}
          onOpenChild={onOpenChild}
        />
      )}
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
        <SessionContextBody task={task} ctx={ctx} onTask={onTask} />
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
