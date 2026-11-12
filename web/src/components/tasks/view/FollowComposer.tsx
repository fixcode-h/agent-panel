/**
 * 对话页底部「继续输入要求」的输入框：附件、@ 引用、/ 命令、提问开关、模型、继续执行 / 重试。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条）：发送、停止这些动作由 TaskView 的 useTaskActions 给，这里只画
 */
import { Loader2, RotateCw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Agent, TaskStep } from '@shared/schema'
import { liveActive, type TaskLive } from '@shared/live/task-live'
import { withTaskModel } from '@shared/task'
import { api, type TaskPage } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { AskToggle } from '@/components/chat/AskToggle'
import type { useAttachments, useFileMention } from '@/components/chat/Attachments'
import { ChatComposer } from '@/components/chat/ChatComposer'
import type { RichInputHandle } from '@/components/chat/RichInput'
import type { useSlashMenu } from '@/components/chat/SlashMenu'
import { ChatModelPicker, RoleModelBadge, type ChatRun } from '../ChatModelPicker'
import { continueHint } from '../composer-hint'
import { RetryModelMenu } from '../RetryModelMenu'
import { TaskContextRing } from '../TaskMeta'
import { HandBackTag } from '../UserActionPanel'

export interface FollowComposerProps {
  task: TaskPage
  live?: TaskLive
  taskId: string
  aiLook: boolean
  working: boolean
  sending: boolean
  resuming: boolean
  canSteer: boolean
  /** 「继续执行 / 重试」按钮：停下或失败、输入框空着、名下没有还在跑的（TaskView 按对话状态算好） */
  showResume: boolean
  /** 失败了：按钮写「重试」，旁边多一个换模型重发（只给对话） */
  failed: boolean
  canPickFlow: boolean
  canMention: boolean
  /** 这一轮没在跑时在等什么（liveWaitText），空字符串是没在等 */
  waitText: string
  /** 流程图视图里节点自己有拖拽，不接管；其余时候拖到对话页任何位置都算引入 */
  dropScope: HTMLElement | null
  /** 流程图里选中的节点：上下文圆环按它算 */
  node?: TaskStep
  files: ReturnType<typeof useAttachments>
  mention: ReturnType<typeof useFileMention>
  slash: ReturnType<typeof useSlashMenu>
  taRef: React.RefObject<RichInputHandle | null>
  byCli: boolean
  chatRun: ChatRun
  chatAgent?: Agent
  /** 工作流对话：输入框左下角那一句说明 */
  flowHint?: string
  resumeTitle: string
  onEmptyChange: (empty: boolean) => void
  onDropOver: (over: boolean) => void
  send: (text?: string) => Promise<void>
  stop: () => Promise<void>
  resume: () => Promise<void>
  changeRun: (v: ChatRun) => Promise<void>
  setTask: (t: TaskPage) => void
  apply: (t: TaskPage) => void
}

export function FollowComposer(p: FollowComposerProps) {
  const { task, working, waitText, files, mention, slash, apply } = p
  return (
    <ChatComposer
      // 设计稿的追问框：深一档的细线、圆角 12；附件、模型、提问开关这些照旧留在下面一行
      className={p.aiLook ? 'rounded-xl border-line-strong' : undefined}
      id="follow-up"
      // 草稿由输入框自己记：打字只重渲染输入框，不带着整页消息重画
      draftKey={`task:${p.taskId}`}
      onEmptyChange={p.onEmptyChange}
      onSubmit={(v) => void p.send(v)}
      files={files}
      taRef={p.taRef}
      // 拖文件到页面任何位置都算引入到要求里；流程图视图里节点自己有自己的拖拽，不接管
      dropScope={p.dropScope}
      onDropOver={p.onDropOver}
      above={<HandBackTag task={task} />}
      menus={
        <>
          {mention.menu}
          {slash.menu}
        </>
      }
      onSync={() => {
        mention.sync()
        slash.sync()
      }}
      onKeyDown={(e) => slash.onKeyDown(e) || mention.onKeyDown(e)}
      // 空着按 ↑ 取回自己上一条发的话（不取父对话、面板代发的）
      recall={() => [...task.messages].reverse().find((m) => m.role === 'user' && !m.peer && !m.panel)?.text}
      attach={{
        onMention: mention.start,
        canMention: p.canMention,
        self: task.id,
        workflows: p.canPickFlow,
      }}
      tools={
        <>
          <AskToggle
            value={task.askUser}
            onChange={(v) => {
              p.setTask({ ...task, askUser: v })
              api.setTaskAskUser(task.id, v).then(apply, (e) => toast.error((e as Error).message))
            }}
            // 只有父对话有「子对话也提问」：子对话页面不传回调，右键菜单不出现
            childAskUser={task.childAskUser}
            onChildAskUserChange={
              task.parentTaskId
                ? undefined
                : (on, applyExisting) => {
                    api
                      .setTaskChildAskUser(task.id, on, applyExisting)
                      .then(apply, (e) => toast.error((e as Error).message))
                  }
            }
          />
          {/* Agent、模型、思考强度和新建对话的输入框一样放在左下角（不挪到标题栏）。不用角色的对话能换；
              用角色的对话跟着角色设置，只读显示 */}
          {p.byCli ? (
            <ChatModelPicker value={p.chatRun} onChange={p.changeRun} />
          ) : (
            p.chatAgent && <RoleModelBadge agent={withTaskModel(p.chatAgent, task)} />
          )}
          {p.flowHint !== undefined && <span className="min-w-0 truncate pl-1 text-xs text-subtle">{p.flowHint}</span>}
        </>
      }
      // 对话还在运行（自己在跑，或者子对话、子任务、后台命令、工作流还没完）就是停止按钮：
      // 停止会把这些附属的一起停掉（见服务端 /stop），判定和标题栏、侧栏同一个（taskActive）
      running={working || liveActive(p.live)}
      // 正在发送上一句：Enter 和按钮一起拦住，并给一句提示（见 ChatComposer 的 blocker）
      sending={p.sending}
      onStop={p.stop}
      leading={
        <>
          <TaskContextRing task={task} node={p.node} />
          {p.showResume && (
            <Button
              size="sm"
              variant="secondary"
              className="rounded-lg"
              disabled={p.resuming}
              onClick={() => p.resume()}
              title={p.resumeTitle}
            >
              {p.resuming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
              {p.failed ? t('重试') : t('继续执行')}
            </Button>
          )}
          {/* 失败后换个模型重发这一轮（用户自己点的）；只给对话，工作流节点的模型跟着节点走 */}
          {p.showResume && p.failed && task.mode === 'chat' && (
            <RetryModelMenu task={task} agent={p.chatAgent} disabled={p.resuming} onDone={apply} />
          )}
        </>
      }
      label={t('继续输入要求')}
      placeholder={
        p.aiLook && !working && !waitText
          ? t('追问，或让它换个方向查…')
          : !working
            ? waitText
              ? t('{what}，可以直接输入要求', { what: waitText })
              : continueHint(task)
            : p.canSteer
              ? t('执行中也可以输入：相关的会调整当前方向，无关的等这一轮完成后再处理')
              : t('执行中也可以输入，这一轮结束后接着处理')
      }
    />
  )
}

/** 工作流对话里输入框左下角那一句：执行中几个节点、停在哪、会从哪继续 */
export function flowHint(c: {
  busy: boolean
  failed: boolean
  blocked?: TaskStep
  running: number
  allDone: boolean
  mainName: string
}) {
  if (c.busy) return c.running > 1 ? t('{n} 个节点同时执行中', { n: c.running }) : t('执行中，可以随时暂停')
  if (c.blocked) return t('主角色处理后会接着走流程')
  if (c.allDone) return t('由主角色 {name} 处理追加要求', { name: c.mainName })
  return c.failed ? t('会从失败的节点重新执行') : t('会从没完成的节点继续执行')
}
