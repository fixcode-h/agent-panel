/**
 * 对话页输入框的状态：草稿空不空、编辑器句柄、附件、@ 引用、拖文件的范围、消息「引用」、「/」菜单。
 * 从 TaskView.tsx 拆出来（复查报告 B2）：页面只把结果交给 FollowComposer 和动作 hook
 */
import { useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Agent, Project, Settings } from '@shared/schema'
import { dropChip } from '@shared/composer'
import { agentRun, defaultCli, defaultSettings } from '@shared/settings'
import { withTaskModel } from '@shared/tasks/run'
import { api, type TaskPage } from '@/lib/api'
import { useQuoteTarget } from '@/lib/quote'
import { toast } from '@/lib/toast'
import { useAttachments, useFileMention } from '@/components/chat/Attachments'
import type { RichInputHandle } from '@/components/chat/RichInput'
import { useSlashMenu } from '@/components/chat/SlashMenu'

export interface TaskComposerCtx {
  taskId: string
  task: TaskPage | null
  project?: Project
  allProjects: Project[]
  agents: Agent[]
  settings?: Settings | null
  /** 任务在跑（见 lib/live/follow）：压缩、审查这类「/」动作要等它停 */
  running: boolean
  apply: (t: TaskPage) => void
  stickToBottom: () => void
}

export function useTaskComposer(c: TaskComposerCtx) {
  const { task, project, settings } = c
  // 没发出去的内容由 ChatComposer 自己按对话记着（切走再回来还在），打字时不再重渲染整页；
  // 这里只留一个「输入框是不是空的」，给「继续执行」按钮用，只在空 / 非空切换时更新
  const [draftEmpty, setDraftEmpty] = useState(true)
  const taRef = useRef<RichInputHandle>(null)
  // 和新建任务的输入框一样：可以附文件、粘贴截图、拖进来、输入 @ 引用项目文件
  const files = useAttachments(`task:${c.taskId}`)
  // Chat 页的对话没有项目：@ 在所有项目里一起搜
  const mention = useFileMention(project, taRef, files, task?.projectId ? [] : c.allProjects)
  // 拖文件的接收范围：对话页的主区域（消息流、状态行、子对话、输入框），右栏不在里面。
  // 用 state 存元素：ref 在首帧还是空的，effect 拿不到要监听的节点
  const [dropArea, setDropArea] = useState<HTMLElement | null>(null)
  // 消息下面的「引用」：像附件一样在输入框末尾放一张引用卡片，不把整段原文铺进输入框；
  // 原文跟着附件走，发出去后对话里还是这张卡片，交给 Agent 时才换成引用块
  useQuoteTarget(dropArea, (quoted) => {
    const ed = taRef.current
    if (!ed) return
    ed.focus()
    ed.setCaret(Number.MAX_SAFE_INTEGER)
    files.addQuote(quoted, {
      added: (items) => items.forEach((x) => ed.insertChip({ kind: x.kind, name: x.name })),
      failed: (name) => ed.setText(dropChip(ed.text(), name)),
    })
  })
  const [dropOver, setDropOver] = useState(false)
  // 「/」菜单：对话任务按现在用的 CLI 列命令和 Skill；工作流的节点都用默认 CLI，按它列，发出去时展开成普通的要求
  const slashAgent = task?.mode === 'chat' ? c.agents.find((a) => a.id === task.agentId) : undefined
  const slashCli =
    task?.mode === 'workflow'
      ? defaultCli(settings ?? defaultSettings())
      : slashAgent && task
        ? agentRun(withTaskModel(slashAgent, task), settings ?? defaultSettings()).cli
        : task?.mode === 'chat'
          ? defaultCli(settings ?? defaultSettings())
          : ''
  const slash = useSlashMenu({
    cli: slashCli,
    projectId: project?.id,
    // 压缩、审查是对话的操作，工作流里不提供
    scope: task?.mode === 'workflow' ? 'new' : 'task',
    // 草稿在输入框里，命令菜单清空 / 换内容时交给它
    setText: (v) => taRef.current?.setText(v),
    editor: taRef,
    onAction: (a, arg) => {
      if (!task) return
      if (c.running) return void toast.error(t('任务正在执行，请等它完成或先停止'))
      c.stickToBottom()
      ;(a === 'compact' ? api.compactTask(task.id) : api.reviewTask(task.id, arg))
        .then(c.apply)
        .catch((e) => toast.error((e as Error).message))
    },
  })
  return { draftEmpty, setDraftEmpty, taRef, files, mention, dropArea, setDropArea, dropOver, setDropOver, slash }
}
