import { useState } from 'react'
import { Archive, ArchiveRestore, Pause, PencilLine, Pin, PinOff, Play, Power, PowerOff, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import type { Task } from '@shared/schema'
import { TRASH_RETENTION_DAYS } from '@shared/task'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { DeleteTaskDialog } from './Worktrees'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/menu'
import { InlineRename } from '@/components/ui/inline-rename'
import { useTaskControl } from './TaskControl'
import { t } from '@shared/i18n'

/**
 * 任务行右键菜单的动作（工作区任务列表、侧栏共用）：暂停 / 继续、激活 / 关闭 Agent、重命名、置顶（只有聊天）、归档、删除。
 * items 放进 ContextMenuContent，confirm 放在行外面；重命名时把行换成 TaskRenameInput。
 */
export function useTaskRowMenu(task: Task, onDeleted?: () => void) {
  const { removeTask, upsertTask } = useData()
  const control = useTaskControl(task)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const chat = !task.projectId
  const rename = async (title: string) => {
    setRenaming(false)
    title = title.trim()
    if (!title || title === task.title) return
    try {
      upsertTask(await api.renameTaskSummary(task.id, title))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const archive = async (archived: boolean) => {
    try {
      upsertTask(await api.archiveTaskSummary(task.id, archived))
      toast.success(archived ? t('已归档，可以在筛选里选「已归档」找到') : t('已取消归档'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const pin = async (pinned: boolean) => {
    try {
      upsertTask(await api.pinTaskSummary(task.id, pinned))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  // CLI 进程还活着（含预热中、停在等下一句）：给「关闭 Agent」；没有进程时对话任务给「激活 Agent」
  const agentAlive = !!task.cliAlive || task.prewarming || task.awaitingUser
  const canActivate = !agentAlive && task.mode === 'chat' && !task.imported && !task.archived
  const showAgent = agentAlive || canActivate
  const [agentBusy, setAgentBusy] = useState(false)
  const toggleAgent = async () => {
    if (agentBusy) return
    setAgentBusy(true)
    try {
      if (agentAlive) {
        upsertTask(await api.closeAgentSummary(task.id))
        toast.success(t('已关闭 Agent，下一条消息会接着原来的会话'))
        return
      }
      const next = await api.activateAgentSummary(task.id)
      upsertTask(next)
      // 没有会话、CLI 不支持停在等待上时服务端原样返回：说清楚，别让用户以为已经启动了
      if (next.cliAlive || next.prewarming || next.awaitingUser || next.working) toast.success(t('Agent 已激活'))
      else toast.info(t('这个对话现在不能提前启动 Agent，发消息时会自动启动'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAgentBusy(false)
    }
  }
  const remove = async () => {
    try {
      await api.deleteTask(task.id)
      removeTask(task.id)
      onDeleted?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }
  const items = (
    <>
      {control.action && (
        <>
          <ContextMenuItem disabled={control.busy} onSelect={control.run}>
            {control.action === 'pause' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {control.label}
          </ContextMenuItem>
          {/* 和下面的 Agent 开关同属「执行」一组，只在组尾分隔一次 */}
          {!showAgent && <ContextMenuSeparator />}
        </>
      )}
      {showAgent && (
        <>
          {/* 正在执行这一轮的不能关：关进程会把这一轮掐断，那是「暂停」的事 */}
          <ContextMenuItem disabled={agentBusy || (agentAlive && !!task.working)} onSelect={toggleAgent}>
            {agentAlive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
            {agentAlive ? t('关闭 Agent') : t('激活 Agent')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={() => setRenaming(true)}>
        <PencilLine className="h-4 w-4" />
        {t('重命名')}
      </ContextMenuItem>
      {/* 置顶只给 Chat 页的聊天：项目里的对话按项目分组、按状态排，没有「置顶」这一组 */}
      {chat && (
        <ContextMenuItem onSelect={() => pin(!task.pinned)}>
          {task.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          {task.pinned ? t('取消置顶') : t('置顶聊天')}
        </ContextMenuItem>
      )}
      {task.archived ? (
        <ContextMenuItem onSelect={() => archive(false)}>
          <ArchiveRestore className="h-4 w-4" />
          {t('取消归档')}
        </ContextMenuItem>
      ) : (
        /* 只有正在执行这一轮的不能归档；CLI 只是活着（等下一句、预热）的可以，归档时由服务端结束进程 */
        <ContextMenuItem disabled={!!task.working} onSelect={() => archive(true)}>
          <Archive className="h-4 w-4" />
          {t('归档')}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem danger onSelect={() => setDeleting(true)}>
        <Trash2 className="h-4 w-4" />
        {t('删除')}
      </ContextMenuItem>
    </>
  )
  const confirm = (
    <DeleteTaskDialog
      task={task}
      open={deleting}
      onOpenChange={setDeleting}
      title={t('删除「{name}」？', { name: task.title })}
      description={
        chat
          ? t('这次聊天会移进回收站，{days} 天内可以恢复。', { days: TRASH_RETENTION_DAYS })
          : t('任务记录会移进回收站，{days} 天内可以恢复；项目里的文件不受影响。', { days: TRASH_RETENTION_DAYS })
      }
      onConfirm={remove}
    />
  )
  return { renaming, setRenaming, rename, items, confirm }
}

/**
 * 重命名任务的行内输入框：回车或失焦提交，Esc 取消。
 * 外观和「一次编辑只结束一次」的规则都在 ui/InlineRename，这里只按任务类型给读屏名
 */
export function TaskRenameInput({
  task,
  onCommit,
  onCancel,
  className,
}: {
  task: Task
  onCommit: (title: string) => void
  onCancel: () => void
  className?: string
}) {
  return (
    <InlineRename
      value={task.title}
      label={task.projectId ? t('任务标题') : t('聊天标题')}
      onCommit={onCommit}
      onCancel={onCancel}
      className={className}
    />
  )
}
