/**
 * 对话页上点了就调接口的动作：发送（含本地先插一条待认领）、重发、分叉、停止、继续、改名、删除、换模型、
 * 子对话的继续 / 回答 / 解决。从 TaskView.tsx 拆出来（重构文档第 13 条）：
 * 用到的页面状态都放在 ctx 里显式传进来；这几个动作自己的「进行中」状态（发送中、继续中…）收在这里。
 * 出错一律照原文弹给用户，不悄悄重试
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import type { Attachment, Project, Task, TaskMessage, Workflow } from '@shared/schema'
import { taskSummary, TRASH_RETENTION_DAYS } from '@shared/task'
import { withWorkflow } from '@shared/flow/run'
import { forSend } from '@shared/composer'
import { api, type TaskPage } from '@/lib/api'
import { toast } from '@/lib/toast'
import { expandQuotes } from '@/lib/quote'
import { deliveredToCli, messageRecorded } from '@/lib/tasks'
import type { Route } from '@/lib/data'
import { ATTACHMENT_PROMPT, type useAttachments } from '@/components/chat/Attachments'
import type { RichInputHandle } from '@/components/chat/RichInput'
import type { useSlashMenu } from '@/components/chat/SlashMenu'
import type { ChatRun } from '../ChatModelPicker'
import type { ChildSummary } from '../child-line'
import { handBackFor } from '../UserActionPanel'

export interface TaskActionsCtx {
  taskId: string
  task: TaskPage | null
  project?: Project
  workflows: Workflow[]
  working: boolean
  apply: (t: TaskPage) => void
  setTask: (t: TaskPage) => void
  /** 手上最新的一份（SSE 可能比渲染快）：发送失败时先看本地有没有这条 */
  lastTask: React.RefObject<Task | null>
  files: ReturnType<typeof useAttachments>
  taRef: React.RefObject<RichInputHandle | null>
  slash: ReturnType<typeof useSlashMenu>
  stickToBottom: () => void
  upsertTask: (t: TaskPage) => void
  removeTask: (id: string) => void
  go: (r: Route) => void
  loadChildren: (id: string) => Promise<ChildSummary[]>
  setChildren: (list: ChildSummary[]) => void
  closeDelete: () => void
}

export function useTaskActions(c: TaskActionsCtx) {
  const { task, apply, files, taRef, working } = c
  const [sending, setSending] = useState(false)
  const [resuming, setResuming] = useState(false)
  // 子对话的「解决」标记正在提交：防重复点击
  const [resolving, setResolving] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // 点发送后先本地插进对话的那几条（待认领）：清空输入框、消息出现都不等接口返回。
  // 单独存、不塞进 task.messages：SSE 推来的整份任务会把它抹掉（见 TaskView 画对话时合的 shownTask）
  const [pendingMsgs, setPendingMsgs] = useState<TaskMessage[]>([])
  // 输入框里此刻的附件（渲染时同步）：发送时立刻清空，失败要把这次发的那几个放回去，
  // 不能读闭包里的旧列表——那会把刚清空的当成还在，反倒让附件丢了（见 restoreDraft）
  const attachmentsNow = useRef<Attachment[]>([])
  attachmentsNow.current = files.attachments
  // 服务端已经把这条记进对话了（推送或响应到达）：本地那条待认领的退场，显示服务端那一份
  // （两边同一个 id：发送时页面生成、接口传过去，见 api.sendMessage 的 messageId）
  useEffect(() => {
    if (!pendingMsgs.length || !task) return
    const ids = new Set(task.messages.map((m) => m.id))
    const rest = pendingMsgs.filter((m) => !ids.has(m.id))
    if (rest.length !== pendingMsgs.length) setPendingMsgs(rest)
    // 只跟着任务变：pendingMsgs 自己变了不用再筛一遍
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task])

  const send = async (input?: string) => {
    if (!task) return
    const text = input ?? taRef.current?.text() ?? ''
    if (!text.trim() && !files.attachments.length && !files.needPicks) return
    // 输入框已经拦过一道（Enter 和按钮同一个 ready）：这里再拦一次，并说清原因，不默默丢掉用户写的字
    if (sending || files.uploading) {
      toast.info(
        files.uploading ? t('附件还在{status}，稍等一下', { status: files.waiting }) : t('上一条还在发送，稍等一下'),
      )
      return
    }
    // 视频卡片换成选好的帧；还有没选帧的视频时先打开截帧弹窗
    const framed = files.prepare(text)
    if (framed === null) return
    // 引入了工作流（行内的工作流卡片）：这条要求点名它，父对话照用户点名的起工作流子对话（ADR 0044）
    const said = withWorkflow(expandQuotes(framed, files.attachments), c.workflows)
    const content = forSend(said, files.attachments.length ? ATTACHMENT_PROMPT : '')
    if (!files.items.length && c.slash.intercept(content)) return
    // 发出去的这一刻就清空输入框、把消息插进对话。清空不能等接口返回：服务端这条的响应要等
    // settings、项目、git/p4 探测、CLI 拉起这一串（消息本身早已经 SSE 到界面），
    // 以前就是在这里 await 完才清空，于是出现「气泡已经标了已交给 Agent、输入框还满着」
    const attachments = files.attachments
    const messageId = crypto.randomUUID()
    const pending: TaskMessage = {
      id: messageId,
      role: 'user',
      agentId: '',
      step: '',
      text: content,
      tools: [],
      ...(attachments.length ? { attachments } : {}),
      // 面板还没接收、Agent 还没认领；服务端记下这条后换成「已交给 Agent，这一轮接着处理」
      delivery: { how: 'pending', at: new Date().toISOString() },
      at: new Date().toISOString(),
    }
    setPendingMsgs((xs) => [...xs, pending])
    taRef.current?.setText('')
    files.clear()
    // 这次发的已经清掉了：失败时只把这几个放回去，用户在这几秒里新加的不用跟着猜
    attachmentsNow.current = []
    c.stickToBottom()
    setSending(true)
    try {
      const sent = await api.sendMessage(task.id, content, attachments, false, messageId, handBackFor(task))
      apply(sent)
      // 面板自己处理的命令（例如 /rule 发布全局规则）不把这条记进对话：服务端返回的对话里没有这个 id，
      // 本地那条「待认领」要撤掉，否则会一直挂在对话里（只有切走或刷新才消失）
      if (!messageRecorded(sent.messages, messageId)) setPendingMsgs((xs) => xs.filter((m) => m.id !== messageId))
      setTimeout(
        () =>
          api
            .task(task.id)
            .then(apply)
            .catch(() => {}),
        200,
      )
    } catch (e) {
      // 请求失败不等于没发出去：服务端可能已经收下并推到了界面（消息上已经写着「已交给 Agent」），
      // 只是响应因连接中断没回来。先确认这条有没有被服务端记下，记下了就别把原文又放回输入框
      // （那正是用户报的「消息发出去了、输入框里字还在」，用户再回车会再发一条一样的）
      const landed = await landedMessage(task.id, messageId)
      if (deliveredToCli(landed)) {
        toast.error((e as Error).message)
        return
      }
      // 没发出去（或服务端自己标了「没送出去」）：本地那条撤回，原文和附件放回输入框，
      // 不能既没发出又把用户写的字弄丢
      setPendingMsgs((xs) => xs.filter((m) => m.id !== messageId))
      restoreDraft(text, attachments)
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  /**
   * 这条消息服务端记下来没有：先看本地（SSE 可能已经推到了），再问一次服务端。
   * 请求报错时用它决定是把原文放回输入框还是只提醒一次
   */
  async function landedMessage(id: string, messageId: string) {
    const local = c.lastTask.current?.messages.find((m) => m.id === messageId)
    if (local) return local
    return api
      .task(id)
      .then((t) => t.messages.find((m) => m.id === messageId))
      .catch(() => undefined)
  }
  // 发送失败时把原文、附件放回输入框：输入框已经空了就原样放回，用户已经接着写了就接在他写的内容后面，
  // 两种情况都不能让他刚写的东西丢掉。用函数声明：send 在上面引用它，事件触发时它已经定义
  function restoreDraft(text: string, attachments: Attachment[]) {
    const ed = taRef.current
    const cur = ed?.text() ?? ''
    ed?.setText(cur.trim() ? `${cur}\n\n${text}` : text)
    if (attachments.length) {
      // 这次发的和用户刚加的可能有重叠（同一个文件重新加过）：按路径去重，不重复摆两张卡片
      const extra = attachmentsNow.current.filter((a) => !attachments.some((x) => x.path === a.path))
      files.replace([...extra, ...attachments])
    }
    ed?.focus()
  }
  /** 不碰输入框直接发一句（「处理」按钮、分诊卡、重新生成、交给角色整理教训）：草稿和附件原样留着 */
  const say = async (text: string, attachments: Attachment[] = []) => {
    if (!task) return
    c.stickToBottom()
    apply(await api.sendMessage(task.id, text, attachments, false))
  }
  const fork = async (messageId: string) => {
    if (!task) return
    try {
      const f = await api.forkTask(task.id, messageId)
      c.upsertTask(taskSummary(f))
      toast.success(t('已分叉成新的对话'))
      c.go(f.projectId ? { page: 'projects', id: f.projectId, sub: f.id } : { page: 'chat', id: f.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  // 没送出去的那条：原文和附件照原样再发一次，不用用户自己复制粘贴（不碰输入框里正在写的草稿）
  const resend = async (m: TaskMessage) => {
    try {
      await say(m.text, m.attachments ?? [])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const stop = async () => {
    if (!task) return
    try {
      apply(await api.stopTask(task.id))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const forceStop = async () => {
    if (!task) return
    try {
      apply(await api.stopTask(task.id, true))
      toast.success(t('已强制停止，Agent 进程已结束'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const resume = async (latest = false) => {
    if (!task) return
    setResuming(true)
    c.stickToBottom()
    try {
      apply(await api.resumeTask(task.id, latest))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setResuming(false)
    }
  }
  // 子对话改了状态后马上读回子对话列表：卡片状态本来就 4 秒刷一次，这里先把刚拿到的状态读回来，不用等下一拍
  const reloadChildren = () =>
    void c
      .loadChildren(c.taskId)
      .then(c.setChildren)
      .catch(() => {})
  // 在父对话页直接允许 / 拒绝子对话的请求：回答后马上读回子对话列表，那一行跟着消失；出错照实提示
  const answerChild = async (childId: string, rid: string, allow: boolean) => {
    try {
      await api.answerRequest(childId, rid, { allow })
    } catch (e) {
      toast.error((e as Error).message)
    }
    reloadChildren()
  }
  // 父对话页上给停下的子对话一键继续：走和它自己页面同一个接口（重新占执行位），不另造一套。
  // 只刷新子对话栏，不往全局任务列表里塞摘要：它会和父对话的 childrenWorking 重复计数（侧栏「N 个执行中」会闪一下）
  const resumeChild = async (id: string) => {
    try {
      await api.resumeTask(id)
      toast.success(t('已让它接着做'))
      reloadChildren()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  // 子对话标记为已解决：请求走子对话一侧的完成流转（服务端判定 → 置完成 → 上报父对话）。
  // 用户点「解决」时计划里没做完的步骤一并收口（服务端 fromUser 这条路径，见 settleChildForUser），
  // 其余还没收口的东西（这一轮在跑、独立分支没合回、待回答的提问）仍返回 409，把卡在哪一项弹给用户；
  // 已经解决的重复点击不再发请求
  const resolveChild = async () => {
    if (resolving || !task || task.resolved) return
    setResolving(true)
    try {
      apply(await api.resolveTask(c.taskId, true))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setResolving(false)
    }
  }
  // 改名输入框（InlineRename）交回最终的值；renaming 只记「正在改、从哪个标题开始改」
  const rename = async (value: string) => {
    const title = value.trim()
    setRenaming(null)
    if (!task || !title || title === task.title) return
    try {
      apply(await api.renameTask(task.id, title))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async () => {
    if (!task) return
    try {
      await api.deleteTask(task.id)
      c.removeTask(task.id)
      toast.success(t('已移进回收站，{days} 天内可以恢复', { days: TRASH_RETENTION_DAYS }))
      c.go(c.project ? { page: 'projects', id: c.project.id } : { page: 'chat' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      c.closeDelete()
    }
  }
  const changeRun = async (v: ChatRun) => {
    if (!task) return
    c.setTask({ ...task, ...v })
    try {
      apply(await api.setChatRun(task.id, v))
      // 空闲时服务端会马上换进程；只有真正在回复这一轮才需要等到下一轮
      if (working) toast(t('改好了，下一轮回复开始生效'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return {
    sending,
    resuming,
    resolving,
    pendingMsgs,
    name: { renaming, setRenaming, rename },
    send,
    say,
    fork,
    resend,
    stop,
    forceStop,
    resume,
    answerChild,
    resumeChild,
    resolveChild,
    remove,
    changeRun,
  }
}
