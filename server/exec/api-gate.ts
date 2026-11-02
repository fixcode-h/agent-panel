/** API 并发名额：拿名额（满了排队并标出在等哪个 API）、等别人时让出再拿回。从 runner.ts 拆出 */
import type { AgentCall } from '../../shared/engine.ts'
import { ApiSlot } from '../api-slots.ts'
import type { RealContext } from './real-context.ts'
import { type TaskStep, aliasAgent } from '../../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import { clearApiWait, markApiWait } from './api-wait.ts'
import { nodeAgentRun } from '../../shared/agent-role.ts'
import { turnRole } from '../../shared/conv-mode.ts'
import { withTaskModel } from '../../shared/task.ts'

/** 两个信号任一触发就触发（AbortSignal.any 要 Node 20.3+；包现在要求 22，这里留着兜底） */
export function anySignal(a: AbortSignal, b: AbortSignal) {
  const ac = new AbortController()
  const fire = (x: AbortSignal) => () => ac.abort(x.reason)
  if (a.aborted || b.aborted) ac.abort((a.aborted ? a : b).reason)
  else {
    a.addEventListener('abort', fire(a), { once: true })
    b.addEventListener('abort', fire(b), { once: true })
  }
  return ac.signal
}

/**
 * 正在跑的调用手里的 API 名额：任务 id + 节点 id（对话这一轮是空的）→ 名额。
 * 等下一句、等子任务、等别的 Agent 回答时让出，接着干之前再拿回（见 waitNext 和 yieldApiSlot）
 */
export const apiSlots = new Map<string, ApiSlot>()
export const slotKey = (taskId: string, step: string) => `${taskId}\n${step}`
/** 正停在 wait_agents / ask_main 里等别人的调用（slotKey）：见 yieldApiSlot */
export const inToolWait = new Set<string>()

/** 这次调用要用的 API：CLI 的登录方式是 API 时才有；账号登录不受并发上限管 */
export function callApi(ctx: RealContext, call: AgentCall) {
  const id = ctx.agents.some((a) => a.id === call.agentId) ? call.agentId : aliasAgent(call.agentId)
  const found = turnRole(ctx.task, ctx.agents, id)
  // 找不到角色时由 runAgent 报错
  if (!found) return undefined
  const agent =
    call.tier !== undefined ? nodeAgentRun(found, call.tier, defaultCli(ctx.settings)) : withTaskModel(found, ctx.task)
  return cliSettings(ctx.settings, agentRun(agent, ctx.settings).cli).api
}

/**
 * 拿名额；满了就排队，排队时对话（或子任务、节点）上标出在等哪个 API、前面还有几个。
 * 排队的子任务、节点显示成「排队中」，拿到再回到执行中。停止信号到了返回 false
 *
 * 标记用 try/finally 无条件清：只清「这次排过队」会在复用别处排队时漏清（排队标记就会跟到任务结束）。
 * reason 区分开跑前排队还是让出后拿回，后者不显示成「排队等名额」。
 */
export async function takeApiSlot(
  ctx: RealContext,
  step: TaskStep | undefined,
  slot: ApiSlot,
  signal: AbortSignal,
  reason: 'start' | 'yield' = 'start',
) {
  let before: TaskStep['status'] | undefined
  try {
    return await slot.take(signal, (ahead) => {
      // 队伍动了会反复回调：before 只在第一次记下，后面不再改状态
      const b = markApiWait(ctx, step, slot.name, ahead, reason)
      if (before === undefined) before = b
    })
  } finally {
    // 不管拿到、被停止还是被让出，标记都必须清：它只能表示「此刻真的在排队」
    clearApiWait(ctx, step, before)
  }
}

/**
 * 调用停下来等别人（wait_agents 等子任务、ask_main 等主 Agent 回答）时让出名额，等完再拿回：
 * 占着名额等子任务，子任务又在排队等名额，就互相等死了
 */
export async function yieldApiSlot<T>(ctx: RealContext, stepId: string, wait: () => Promise<T>): Promise<T> {
  // 对话自己（@chat）不是一个节点，名额记在空的节点 id 下
  if (!ctx.task.steps.some((s) => s.id === stepId)) stepId = ''
  const key = slotKey(ctx.task.id, stepId)
  const slot = apiSlots.get(key)
  // 停在工具里等的这段 CLI 本来就没有输出（wait_agents 一次能等二十几分钟）：空闲检测不算它卡住
  inToolWait.add(key)
  if (!slot?.holding) return wait().finally(() => inToolWait.delete(key))
  slot.drop()
  try {
    return await wait()
  } finally {
    inToolWait.delete(key)
    const step = stepId ? ctx.task.steps.find((s) => s.id === stepId) : undefined
    await takeApiSlot(ctx, step, slot, ctx.signal, 'yield')
  }
}
