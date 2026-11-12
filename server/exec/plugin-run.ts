/**
 * 一轮对话开始时问开着的插件要不要挂工具（ADR 0059）。从 runner.ts 拆出（那个文件到了行数上限）。
 * 插件工具要用户确认时（McpCallContext.confirm，插件接口 2）走面板自己的请求卡片：和推送授权一样是「允许 / 拒绝」，
 * 这一轮结束还没回答的跟着作废，停止对话时也一起收起
 */
import type { Agent } from '../../shared/schema.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { t } from '../../shared/i18n.ts'
import { includedAgents } from '../../shared/agents/role.ts'
import { taskPlugin } from '../../shared/task.ts'
import { pluginToolsForRun } from '../plugins/index.ts'
import type { PluginConfirm } from '../plugins/sdk.ts'
import type { PluginRunHooks } from '../plugins/mcp.ts'
import { dropOwnRequests, panelRequest } from './panel-requests.ts'
import { systemNote } from './recovery.ts'
import { pluginProgress } from '../plugins/progress.ts'
import type { RealContext } from './real-context.ts'

export async function pluginRunTools(
  ctx: RealContext,
  run: {
    agent: Agent
    resume: boolean
    cwd: string
    step: string
    agentId: string
    /** 用户直接在聊的对话（不是派出的子任务、工作流节点），见 PluginRun.conversation */
    conversation: boolean
  },
  /** 插件改文件类工具的守卫和改动记录（插件接口 3，见 server/plugins/mcp.ts 的 PluginRunHooks） */
  hooks?: Omit<PluginRunHooks, 'cwd'>,
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
      conversation: run.conversation,
      cwd: run.cwd,
      agentName: run.agent.name,
      skills: [
        ...new Set([...run.agent.skills, ...includedAgents(run.agent, ctx.agents).flatMap((x) => x.agent.skills)]),
      ],
      resume: run.resume,
    },
    confirm,
    {
      cwd: run.cwd,
      progress: (server, tool, text) => {
        if (pluginProgress(task, server, tool, text)) ctx.changed()
      },
      ...hooks,
    },
  )
  // 插件的提示（例如「UE 桥接可以更新」）：只在新会话开头显示一次，续接的会话不再重复
  if (!run.resume)
    for (const n of r.notices)
      task.messages.push(
        systemNote(ctx.newId(), run.agentId, run.step, t('插件「{name}」：{text}', { name: n.name, text: n.text })),
      )
  // 插件没挂上工具（出错、超时）：对话里写一行警告，不然 Agent 只会说没有这个工具，用户不知道为什么
  if (r.errors.length) {
    const names = r.errors.map((e) => e.name).join(t('、'))
    task.messages.push({
      ...systemNote(
        ctx.newId(),
        run.agentId,
        run.step,
        t('插件「{names}」这一轮没有挂上工具，这个对话暂时用不了它们。', { names }),
      ),
      alert: makeAlert('warn', r.errors.map((e) => `${e.name}（${e.id}）：${e.error}`).join('\n'), 'plugin'),
    })
    ctx.changed(true)
  }
  return {
    ...r,
    close: () => {
      r.close()
      dropOwnRequests(task, own)
    },
  }
}
