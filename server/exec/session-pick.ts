/**
 * 这一轮接哪个 CLI 会话：续接、分叉到某一轮，还是开新会话并带上之前的对话。
 * 从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）；只读任务，不改任务
 */
import type { Task } from '../../shared/schema.ts'
import type { BuildOptions, getCli } from '../../shared/clis.ts'
import { sessionChanged, sessionMoved } from '../../shared/task.ts'
import { carryPrompt } from './transcript.ts'

export interface SessionPickInput {
  task: Task
  sessionKey: string
  cwd: string
  /** 对话自己的一轮（不属于节点） */
  chat: boolean
  /** 压缩、审查这类操作 */
  op: boolean
  prewarm: boolean
  def: NonNullable<ReturnType<typeof getCli>>
  cliId: string
  model: string
  effort: string | undefined
  /** 接口拒绝了旧会话的历史时，调用方带过来的之前的对话 */
  retryCarry: string
}

export function pickSession(x: SessionPickInput) {
  const { task, sessionKey, cwd, chat, op, prewarm, def, cliId, model, effort, retryCarry } = x
  let resume: string | undefined = task.sessions[sessionKey]
  let fork: BuildOptions['fork']
  let carry = ''
  // 触发这一轮的用户消息：结束后在它上面记下这一轮在 CLI 会话里的位置（预热没有触发消息）
  const asker =
    chat && !op && !prewarm ? [...task.messages].reverse().find((m) => m.role === 'user' && !m.step) : undefined
  const rewind = chat ? task.rewind : undefined
  // 对话中途换了 CLI、（不能中途换模型的 CLI 换了）模型或（不支持中途换强度的 CLI 换了）思考强度：
  // 原来的会话接不上，开新会话把之前的对话带过去。
  // 会话开在别的目录里（中途开了独立分支）也接不上：多数 CLI 的会话按目录存，换了目录 --resume 找不到。
  // 子任务一样要查：父对话开了独立分支后，子任务的会话还留在原目录。能跨目录续接的（resumeAnyDir）照样续接
  const moved = sessionMoved(task, sessionKey, cwd, chat, def.resumeAnyDir)
  const switched =
    chat && (sessionChanged(task, cliId, model, effort, def.effortBoundSession, def.modelSwitch) || moved)
  if (switched) resume = undefined
  // 子任务没有「对话记录」可带：会话在别的目录里就丢掉，这次用完整提示新开一个
  else if (moved) resume = undefined
  if (retryCarry) {
    // 接口拒绝了旧会话的历史：丢掉它重开，把之前的对话带上
    resume = undefined
    carry = retryCarry
  } else if (rewind || switched) {
    const th = rewind?.through ?? null
    resume = undefined
    if (rewind?.summary) carry = `## 之前对话的摘要\n${rewind.summary}`
    else if (switched) {
      // 开了独立分支后接着做：触发这一轮的是面板，不是新的用户消息，上一轮的要求和回复都要带过去
      const upto = asker && !moved ? task.messages.indexOf(asker) : task.messages.length
      carry = carryPrompt(task, upto)
    } else if (th && def.fork === 'turn' && th.id) [resume, fork] = [th.session, { turnId: th.id }]
    else if (th && def.fork === 'end' && th.end) [resume, fork] = [th.session, { end: th.end }]
    // 只能分叉到某一轮之前（Pi）：按丢掉的第一轮截，那一轮要和留下的在同一个会话里
    else if (th && def.fork === 'before' && rewind?.cut?.id && rewind.cut.session === th.session)
      [resume, fork] = [th.session, { before: rewind.cut.id }]
    else if (th && rewind?.latest && def.fork !== 'none') [resume, fork] = [th.session, {}]
    else if (th) {
      // CLI 截不了会话：开新会话，把留下的对话（这条要求之前的）带上
      const upto = asker ? task.messages.indexOf(asker) : task.messages.length
      carry = carryPrompt(task, upto)
    }
  }
  return { resume, fork, carry, asker, rewind }
}
