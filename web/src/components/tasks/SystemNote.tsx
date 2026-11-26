import { useSyncExternalStore } from 'react'
import { Info } from 'lucide-react'
import { compValue } from '@shared/component-style'
import { componentsSnapshot, subscribeComponents } from '@/lib/appearance'
import type { Alert, Task, TaskMessage } from '@shared/schema'
import type { AnalysisScope } from '@shared/analysis-home'
import { makeAlert } from '@shared/alerts'
import { conversationAround } from '@shared/fix'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { AnswerMessage } from '@/components/chat/ChatMessage'
import { AlertRow } from './AlertRow'
import { BugReportLine } from './DiagnosisDialog'
import { LearnedCard } from './LearnedCard'
import { grantNotes } from '@shared/grants/notes'
import { DecisionLine, GrantRunRow } from '@/components/ui/grant-badge'

/**
 * 对话里的系统消息：报错、警告的卡片和居中的一行说明。
 * 从 Messages.tsx 拆出来（那边碰到行数上限），对话页、工作流节点、设计页的对话都用这一份
 */
export function SystemNote({
  text,
  error,
  alert,
  className,
  indent,
  conversation,
  cwd,
  home,
}: {
  text: string
  error?: boolean
  /** 报错、警告的分类和原始信息；旧数据只有 error 时按正文归类 */
  alert?: Alert
  className?: string
  /**
   * 报错、警告卡片和 AI 回复的正文对齐（缩进同 .reply-body）。
   * 卡片挂在回复体外面（对话页、设计页的消息列表）时要传；回复体里面的已经跟着正文缩进了，不传
   */
  indent?: boolean
  /** 报错前后的对话：交给 AI 时一起带上，它才知道出错时在做什么 */
  conversation?: string
  /** 报错所在的项目目录 */
  cwd?: string
  /** 报错属于哪个对话：「AI 处理」按它定分析对话开在哪 */
  home?: AnalysisScope
}) {
  // 报错和警告都画成带底色的一行，点开看这是什么、怎么办和原始信息（见 shared/alerts.ts）。
  // className 是给居中的说明用的，不传给它：点开的说明要左对齐
  if (alert || error) {
    const row = (
      <AlertRow
        alert={alert ?? makeAlert('error', text)}
        text={text}
        conversation={conversation}
        cwd={cwd}
        home={home}
      />
    )
    return indent ? <div className="reply-indent min-w-0">{row}</div> : row
  }
  return (
    // 图标放进文字的同一行里：居中显示时图标跟着第一行字走，不再一个贴最左、一个居中（用户 2026-11-26 截图）
    <div className={cn('text-xs leading-relaxed whitespace-pre-wrap text-subtle [overflow-wrap:anywhere]', className)}>
      <Info className="mr-1.5 inline-block h-3.5 w-3.5 align-[-0.2em]" />
      {text}
    </div>
  )
}

/** 放行记录画成什么：null 是不单独显示，undefined 是照旧画成一行说明 */
function grantNode(m: TaskMessage, msgs: TaskMessage[], task?: Task) {
  const g = m.grant!
  if (g.via === 'user') return <DecisionLine m={m} task={task ?? {}} />
  const view = grantNotes(msgs)
  if (view.hidden.has(m.id)) return null
  const run = view.runs.get(m.id)
  return run ? <GrantRun run={run} task={task} /> : undefined
}

function GrantRun({ run, task }: { run: TaskMessage[]; task?: Task }) {
  const style = useSyncExternalStore(subscribeComponents, componentsSnapshot)
  return <GrantRunRow run={run} task={task ?? {}} open={compValue(style, 'grantBadge', 'runOpen') === true} />
}

/**
 * 对话里的系统消息：用户对提问的回答像用户消息一样显示在正文里，其他的是一行说明。
 * 报错的「AI 处理」带上这条所在的对话（前后几条）和项目路径，AI 才看得出出错时在做什么
 */
export function NoteMessage({
  m,
  task,
  msgs = task?.messages,
  className,
  indent,
}: {
  m: TaskMessage
  /** 整个对话：出错时把这条前后的几条一起交给 AI（不传就用 task 的全部消息） */
  msgs?: TaskMessage[]
  /** 任务：出错时带上项目路径（独立分支里执行时是分支目录） */
  task?: Task
  className?: string
  /** 报错、警告卡片和回复正文对齐，见 SystemNote 的 indent */
  indent?: boolean
}) {
  const { projects } = useData()
  if (m.planStart) return null // 计划启动的那条提示只是把计划输入又抄了一遍，不画出来（按标记判断，不看文案）
  if (m.bugReport) return <BugReportLine text={m.text} />
  if (m.answers?.length) return <AnswerMessage answers={m.answers} at={m.at} />
  // 放行记录（shared/grants/notes.ts）：挂到工具卡片上的不再单独显示；挂不上的同一规则连续几条合成一行；你自己点的允许 / 拒绝画成一行
  if (m.grant) {
    const node = grantNode(m, msgs ?? [], task)
    if (node !== undefined) return node && (indent ? <div className="reply-indent min-w-0">{node}</div> : node)
  }
  // 学到经验：按条展示的卡片（旧消息没有 learned，照旧是下面那一行字）
  if (m.learned) {
    const card = <LearnedCard projectId={task?.projectId} note={m.learned} />
    return indent ? <div className="reply-indent min-w-0">{card}</div> : card
  }
  const around = msgs && (m.error || m.alert) ? conversationAround(msgs, msgs.indexOf(m)) : ''
  const cwd =
    task?.worktree?.state === 'active'
      ? task.worktree.path
      : (projects.find((p) => p.id === task?.projectId)?.path ?? '')
  return (
    <SystemNote
      text={m.text}
      error={m.error}
      alert={m.alert}
      className={className}
      indent={indent}
      conversation={around}
      cwd={cwd}
      home={task ? { kind: 'task', task } : undefined}
    />
  )
}
