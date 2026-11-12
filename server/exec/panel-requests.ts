/**
 * 等用户处理的请求（CLI 的权限请求、提问，面板自己发起的节点确认、推送授权）的回调登记，
 * 和面板自己发起的那几种怎么等。从 runner.ts 拆出来（那个文件到了行数上限）
 */
import type { Task, TaskRequest } from '../../shared/schema.ts'
import { notePushAnswer } from '../../shared/push-auth.ts'
import { t } from '../../shared/i18n.ts'
import type { AskReply } from './parsers.ts'

/** 等用户确认的请求：请求 id → 把结果交回 CLI 的函数。只在内存里，服务重启后 CLI 进程也不在了 */
export const replies = new Map<string, (r: AskReply) => void>() // 模块状态：会话，跟着进程或连接一起没

interface RequestCtx {
  task: Task
  signal: AbortSignal
  newId: () => string
  changed: (flush?: boolean) => void
}

/**
 * 面板自己发起、等用户点的请求：推进 task.requests、登记回调，用户回答后返回回答；
 * 停止任务时作废并返回 null（节点停在这里，继续执行时重新确认）。own 记下这一轮发起的，这一轮结束时一起作废
 */
export function panelRequest(
  ctx: RequestCtx,
  req: Omit<TaskRequest, 'id' | 'at' | 'options'>,
  own?: Set<string>,
): Promise<AskReply | null> {
  return new Promise((resolve) => {
    const { task, signal } = ctx
    if (signal.aborted) return resolve(null)
    const id = ctx.newId()
    const done = (r: AskReply | null) => {
      signal.removeEventListener('abort', onAbort)
      replies.delete(id)
      own?.delete(id)
      task.requests = task.requests.filter((x) => x.id !== id)
      resolve(r)
    }
    const onAbort = () => {
      done(null)
      ctx.changed(true)
    }
    signal.addEventListener('abort', onAbort)
    replies.set(id, (r) => done(r))
    own?.add(id)
    task.requests.push({ ...req, id, options: [], at: new Date().toISOString() })
    // 新的请求马上落盘，侧栏的铃铛和任务页立刻能看到
    ctx.changed(true)
  })
}

/** 这一轮结束了还没回答的面板请求（CLI 等着的 ask_push 随进程一起没了）：作废，卡片收起 */
export function dropOwnRequests(task: Task, own: Set<string>) {
  for (const id of own) replies.get(id)?.({ allow: false, message: '这一轮已经结束，请求作废了' })
  own.clear()
}

/**
 * ask_push 的推送授权卡（kind 'tool' 复用「允许 / 拒绝」卡片）。不受「提问」开关影响：这是授权不是提问，
 * 用户在项目里选了「问一次」就该被问到（autoAnswerQuestions 只自动回答 kind 'question'）
 */
export const askPushRequest = (ctx: RequestCtx, info: { branch?: string; summary?: string }, own?: Set<string>) =>
  panelRequest(
    ctx,
    {
      step: '',
      agentId: '',
      kind: 'tool',
      purpose: 'push',
      title: t('推送到远端并合并主干'),
      detail: [
        info.branch ? t('分支：{branch}', { branch: info.branch }) : '',
        info.summary ?? '',
        t('这个对话里只问这一次，回答会记住。'),
      ]
        .filter(Boolean)
        .join('\n'),
    },
    own,
  )

/** answerRequest 里调：推送授权卡的回答同步写进任务，和这条回答消息一起落盘 */
export function noteAnswer(task: Task, req: TaskRequest, r: AskReply) {
  if (req.purpose === 'push') notePushAnswer(task, r.allow)
}
