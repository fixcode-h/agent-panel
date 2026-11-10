// 对话用哪个 CLI、模型和思考强度。单独成文件：shared/task.ts 有行数上限
import { z } from 'zod'

/**
 * 用角色的对话里用户换的模型：这一轮失败后点「换个模型重试」选的，盖过角色自己的模型。
 * 连同选它时的 CLI 一起记：模型名是那个 CLI 的，之后角色换了 CLI 这份就不再生效，不会把别家的模型名传给新 CLI。
 * 不用角色的对话不用它，直接改 Task.model（输入框里本来就能换）
 */
export const ModelOverride = z.object({ cli: z.string().max(40), model: z.string().trim().min(1).max(200) })
export type ModelOverride = z.infer<typeof ModelOverride>

/** 对话里能不能临时选 CLI、模型和思考强度：不用角色（空 id）时可以 */
export const canPickRun = (agentId: string) => !agentId

/**
 * 对话实际用的 CLI、模型和思考强度。
 * CLI 在对话里定下来就不再跟着设置里的「默认 CLI」变：对话自己选的（新建时选的、在对话里换的）优先，
 * 没选过就用会话所在的 CLI（第一次运行时记下的 sessionCli）。否则用户改了默认 CLI，
 * 已有对话的下一条消息会悄悄换成另一个 CLI、开新会话（实测报告问题 7）。
 * 用角色的对话：角色自己指定了 CLI 就按角色的（改角色是用户主动换）；跟随默认的角色才用对话定下的 CLI，
 * 模型、强度仍按角色的（跟随默认的角色本来就会被套到任意 CLI 上，档位、强度由 agentRun 按 CLI 换算）；
 * 用户在这个对话里换过模型（modelOverride，失败后「换个模型重试」）时用换的那个，CLI 对不上就不用。
 * 工作流节点不走这里（固定用默认 CLI 的档位，见 nodeAgentRun）。
 */
export function withTaskModel<A extends { id: string; cli: string; model: string; effort: string }>(
  agent: A,
  task: {
    mode: string
    agentId: string
    cli?: string
    model?: string
    effort?: string
    sessionCli?: string
    modelOverride?: ModelOverride
  },
): A {
  if (task.mode !== 'chat' || task.agentId !== agent.id) return agent
  const pinned = task.cli || task.sessionCli || ''
  if (!canPickRun(agent.id)) {
    const base = agent.cli || !pinned ? agent : { ...agent, cli: pinned }
    const o = task.modelOverride
    // 角色跟随默认 CLI、对话也还没定下 CLI 时 base.cli 为空：这时没法比，按换的模型用（选的时候就是按实际 CLI 列的）
    return o && (!base.cli || base.cli === o.cli) ? { ...base, model: o.model } : base
  }
  // 换了 CLI 时不能沿用原来的模型（那是另一个 CLI 的）
  const cli = pinned || agent.cli
  const same = cli === agent.cli
  return {
    ...agent,
    cli,
    model: task.model || (same ? agent.model : ''),
    effort: task.effort || (same ? agent.effort : ''),
  }
}

/** 「换个模型重试」能选的模型：这个 CLI 现在能用的模型里去掉正在用的那个，顺序照模型列表 */
export function retryModelChoices<M extends { id: string }>(models: M[], current: string): M[] {
  return models.filter((m) => m.id && m.id !== current)
}

/**
 * 「换个模型重试」选了模型后，对话上要改哪些字段。
 * 不用角色的对话直接改 model；原来的思考强度新模型不支持时清掉（回到新模型的默认），不然 CLI 会因为强度不认直接报错。
 * 用角色的对话记成 modelOverride，角色本身不动：换模型只对这一个对话生效
 */
export function retryModelPatch(
  task: { agentId: string; effort?: string },
  pick: { cli: string; model: string; efforts?: string[] },
): { model: string; effort: string } | { modelOverride: ModelOverride } {
  if (!canPickRun(task.agentId)) return { modelOverride: { cli: pick.cli, model: pick.model } }
  const keep = !!task.effort && (!pick.efforts || pick.efforts.includes(task.effort))
  return { model: pick.model, effort: keep ? task.effort! : '' }
}
