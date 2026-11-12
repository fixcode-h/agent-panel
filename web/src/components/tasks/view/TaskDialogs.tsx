/**
 * 对话页挂在顶层的弹窗：停止 / 强制停止确认、记教训、撤回、删除、文件、后台命令、对话设置、AI 分析。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条）：开关状态由 TaskView 管（标题栏菜单、消息菜单都会打开它们），这里只画。
 * 挂在页面顶层而不是触发它的那一行里：那一行会随一轮输出完、命令跑完卸载，弹窗跟着没了用户就看不到结果
 */
import { t } from '@shared/i18n'
import type { Agent, Attachment, Project } from '@shared/schema'
import { TRASH_RETENTION_DAYS } from '@shared/task'
import { api, type TaskPage } from '@/lib/api'
import { startAnalysis } from '@/lib/task-transfer'
import { ConfirmDialog } from '@/components/ui/dialog'
import { RecordLessonDialog } from '@/components/projects/Lessons'
import { ConversationSettingsDialog } from '../ConversationSettingsDialog'
import { AnalyzeDialog } from '../Evolution'
import { FileDialog } from '../FileDialog'
import { JobDialog, type JobTarget } from '../JobDialog'
import { RewindDialog } from '../RewindDialog'
import { DeleteTaskDialog } from '../Worktrees'

/** 对话页弹窗的开关：每个弹窗一项，值为空（false / '' / null）就是关着 */
export interface TaskDialogState {
  stopAsk: boolean
  forceAsk: boolean
  /** 「记成项目教训」：那条用户消息的原文 */
  lessonOf: string
  /** 「撤回到这里」：那条用户消息的 id */
  rewindAsk: string
  deleting: boolean
  fileTarget: { path: string; line?: number; local?: boolean } | null
  jobTarget: JobTarget | null
  convSettings: boolean
  analyzing: boolean
}

export const NO_DIALOGS: TaskDialogState = {
  stopAsk: false,
  forceAsk: false,
  lessonOf: '',
  rewindAsk: '',
  deleting: false,
  fileTarget: null,
  jobTarget: null,
  convSettings: false,
  analyzing: false,
}

export interface TaskDialogsProps {
  task: TaskPage
  project?: Project
  localAgents: Agent[]
  working: boolean
  state: TaskDialogState
  set: <K extends keyof TaskDialogState>(key: K, value: TaskDialogState[K]) => void
  stop: () => Promise<void>
  forceStop: () => Promise<void>
  remove: () => Promise<void>
  /** 交给对话里的角色整理教训（只给对话任务） */
  askAgent: (message: string) => Promise<void>
  /** 撤回后把那条消息的原文和附件放回输入框 */
  onRewound: (r: { task: TaskPage; text: string; attachments?: Attachment[] }) => void
  apply: (t: TaskPage) => void
  /** 诊断报告、状态和父子往来记录这些自己管开关的弹窗：照原来的顺序夹在后台命令和对话设置之间 */
  more: React.ReactNode
}

export function TaskDialogs(p: TaskDialogsProps) {
  const { task, project, state: s, set, apply, working } = p
  return (
    <>
      <ConfirmDialog
        open={s.stopAsk && working}
        onOpenChange={(v) => set('stopAsk', v)}
        title={t('停止这个任务？')}
        description={t('正在执行的 Agent 会被停下，之后可以点「继续执行」从中断的地方接着做。')}
        confirmText={t('停止')}
        onConfirm={async () => {
          await p.stop()
          set('stopAsk', false)
        }}
      />
      <ConfirmDialog
        open={s.forceAsk}
        onOpenChange={(v) => set('forceAsk', v)}
        title={t('强制停止这个对话？')}
        description={t(
          '正在执行的这一轮会被停下，Agent 进程直接结束（不再留着等下一句）。这一轮已经写出的内容保留，下一句会重新开一个会话。',
        )}
        confirmText={t('强制停止')}
        onConfirm={async () => {
          await p.forceStop()
          set('forceAsk', false)
        }}
      />
      {s.lessonOf && project && (
        <RecordLessonDialog
          project={project}
          text={s.lessonOf}
          taskId={task.id}
          taskTitle={task.title}
          onClose={() => set('lessonOf', '')}
          // 对话里的角色知道刚才哪里做错了，交给它整理；工作流任务和导入的任务没有能接话的角色
          onAskAgent={task.mode === 'chat' ? p.askAgent : undefined}
        />
      )}
      <RewindDialog task={task} messageId={s.rewindAsk} onClose={() => set('rewindAsk', '')} onDone={p.onRewound} />
      <DeleteTaskDialog
        task={task}
        open={s.deleting}
        onOpenChange={(v) => set('deleting', v)}
        title={t('删除任务「{title}」？', { title: task.title })}
        description={t(
          '对话记录会移进回收站，{days} 天内可以在设置 →「数据」→ 回收站里恢复；已经改动的文件不会撤销。',
          { days: TRASH_RETENTION_DAYS },
        )}
        onConfirm={p.remove}
      />
      <FileDialog
        taskId={task.id}
        projectId={task.projectId}
        target={s.fileTarget}
        onOpenChange={(o) => !o && set('fileTarget', null)}
      />
      <JobDialog taskId={task.id} target={s.jobTarget} onOpenChange={(o) => !o && set('jobTarget', null)} />
      {p.more}
      {s.convSettings && (
        <ConversationSettingsDialog
          task={task}
          open={s.convSettings}
          onOpenChange={(v) => set('convSettings', v)}
          onSaved={apply}
        />
      )}
      <AnalyzeDialog
        open={s.analyzing}
        onOpenChange={(v) => set('analyzing', v)}
        subject={task.title}
        start={async (focus) =>
          startAnalysis({
            tasks: [await api.task(task.id)],
            agents: p.localAgents,
            projectId: task.projectId,
            focus,
          })
        }
      />
    </>
  )
}
