import type { AgentUsage, Task, TaskStep } from '../../shared/schema.ts'
import { stepUsage } from '../../shared/task.ts'

/** 上下文占用这几项：属于一个会话（CLI 进程接着的那段对话），不属于角色 */
export type ContextUsage = Pick<AgentUsage, 'context' | 'window' | 'model' | 'parts' | 'snapshot'>

/** 这个角色在任务里的用量记录（速度、累计输出），没有就建一条 */
export function agentUsage(task: Task, agentId: string, model: string, window: number): AgentUsage {
  return (task.usage.agents[agentId] ??= {
    context: 0,
    window,
    model,
    tps: 0,
    lastTps: 0,
    outputTokens: 0,
    genMs: 0,
  })
}

/** 对话里派出的子任务：上下文占用只记在节点自己身上（见 contextUsage） */
export function ownContext(task: Task, owner: TaskStep | undefined): owner is TaskStep {
  return !!owner && task.mode === 'chat'
}

/**
 * 这次调用的上下文占用记在哪。Task.usage.agents 按角色记，对话的会话栏、输入框下的圆环看的就是它：
 * 对话里派出的子任务（节点）常常和对话本身是同一个角色，两个会话同时在跑，按角色记的那一条会被轮流写，
 * 会话栏的「已使用」就在对话的 8% 和子任务的 20% 多之间来回跳（用户报过），对话自己检测「上下文骤降 = 悄悄压缩过」
 * 也会被子任务的数误触发；子任务换了档位、用了窗口小的模型时还会把对话的分母一起改掉。所以对话里的子任务只记自己的（节点的 usage 由 runner 照抄过去），不碰角色那一条；
 * 工作流的节点没有「对话本身」，会话栏按节点找角色，仍记在角色上
 */
export function contextUsage(task: Task, owner: TaskStep | undefined, au: () => AgentUsage): () => ContextUsage {
  if (!ownContext(task, owner)) return au
  const s = stepUsage(owner)
  const own: ContextUsage = { context: s.context, window: s.window, model: s.model }
  return () => own
}
