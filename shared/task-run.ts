// 对话用哪个 CLI、模型和思考强度。单独成文件：shared/task.ts 有行数上限

/** 对话里能不能临时选 CLI、模型和思考强度：不用角色（空 id）时可以 */
export const canPickRun = (agentId: string) => !agentId

/**
 * 对话实际用的 CLI、模型和思考强度。
 * CLI 在对话里定下来就不再跟着设置里的「默认 CLI」变：对话自己选的（新建时选的、在对话里换的）优先，
 * 没选过就用会话所在的 CLI（第一次运行时记下的 sessionCli）。否则用户改了默认 CLI，
 * 已有对话的下一条消息会悄悄换成另一个 CLI、开新会话（实测报告问题 7）。
 * 用角色的对话：角色自己指定了 CLI 就按角色的（改角色是用户主动换）；跟随默认的角色才用对话定下的 CLI，
 * 模型、强度仍按角色的（跟随默认的角色本来就会被套到任意 CLI 上，档位、强度由 agentRun 按 CLI 换算）。
 * 工作流节点不走这里（固定用默认 CLI 的档位，见 nodeAgentRun）。
 */
export function withTaskModel<A extends { id: string; cli: string; model: string; effort: string }>(
  agent: A,
  task: { mode: string; agentId: string; cli?: string; model?: string; effort?: string; sessionCli?: string },
): A {
  if (task.mode !== 'chat' || task.agentId !== agent.id) return agent
  const pinned = task.cli || task.sessionCli || ''
  if (!canPickRun(agent.id)) return agent.cli || !pinned ? agent : { ...agent, cli: pinned }
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
