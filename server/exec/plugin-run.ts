/**
 * 一轮对话开始时问开着的插件要不要挂工具（ADR 0059）。从 runner.ts 拆出（那个文件到了行数上限）。
 * 插件工具要用户确认时（McpCallContext.confirm，插件接口 2）走面板自己的请求卡片：和推送授权一样是「允许 / 拒绝」，
 * 这一轮结束还没回答的跟着作废，停止对话时也一起收起
 */
import type { Agent } from '../../shared/schema.ts'
import { includedAgents } from '../../shared/agent-role.ts'
import { taskPlugin } from '../../shared/task.ts'
import { pluginToolsForRun } from '../plugins/index.ts'
import type { PluginConfirm } from '../plugins/sdk.ts'
import { dropOwnRequests, panelRequest } from './panel-requests.ts'
import type { RealContext } from './real-context.ts'

export async function pluginRunTools(
  ctx: RealContext,
  run: { agent: Agent; resume: boolean; cwd: string; step: string; agentId: string },
) {
  const { task } = ctx
  const own = new Set<string>()
  const confirm = async (req: PluginConfirm) => {
    const r = await panelRequest(
      ctx,
      { step: run.step, agentId: run.agentId, kind: 'tool', title: req.title, detail: req.detail ?? '' },
      own,
    )
    // 停止对话时请求作废（null）：按拒绝处理，插件那边不会写入
    return { allow: !!r?.allow, message: r?.message ?? r?.answer ?? '' }
  }
  const r = await pluginToolsForRun(
    {
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      pluginTask: taskPlugin(task),
      projectId: task.projectId,
      mode: task.mode,
      cwd: run.cwd,
      agentName: run.agent.name,
      skills: [
        ...new Set([...run.agent.skills, ...includedAgents(run.agent, ctx.agents).flatMap((x) => x.agent.skills)]),
      ],
      resume: run.resume,
    },
    confirm,
  )
  return {
    ...r,
    close: () => {
      r.close()
      dropOwnRequests(task, own)
    },
  }
}
