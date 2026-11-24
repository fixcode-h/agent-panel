/**
 * 一轮对话开始时问开着的插件要不要挂工具（ADR 0059）。从 runner.ts 拆出（那个文件到了行数上限）。
 * 插件工具要用户确认时（McpCallContext.confirm，插件接口 2）走面板自己的请求卡片（plugin-confirm.ts），
 * 这一轮结束还没回答的跟着作废，停止对话时也一起收起
 */
import type { Agent } from '../../shared/schema.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { t } from '../../shared/i18n.ts'
import { includedAgents } from '../../shared/agents/role.ts'
import { taskPlugin } from '../../shared/task.ts'
import { convKind } from '../../shared/conv-mode.ts'
import { pluginToolsForRun } from '../plugins/index.ts'
import type { PluginConfirm } from '../plugins/sdk.ts'
import type { PluginRunHooks } from '../plugins/mcp.ts'
import { dropOwnRequests } from './panel-requests.ts'
import { pluginConfirm } from './plugin-confirm.ts'
import { userWordsOf } from '../../shared/review/user-words.ts'
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
    /** 这一轮的角色参数（PluginRun.params） */
    params: Record<string, unknown>
  },
  /** 插件改文件类工具的守卫和改动记录（插件接口 3，见 server/plugins/mcp.ts 的 PluginRunHooks） */
  hooks?: Omit<PluginRunHooks, 'cwd'>,
) {
  const { task } = ctx
  const own = new Set<string>()
  const confirm = (req: PluginConfirm) => pluginConfirm(ctx, run, req, own)
  const r = await pluginToolsForRun(
    {
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      pluginTask: taskPlugin(task),
      projectId: task.projectId,
      // agent（项目里的对话、子对话）、chat（Chat 页）、workflow，存的就是插件接口说的这三种
      mode: task.mode,
      kind: convKind(task),
      conversation: run.conversation,
      cwd: run.cwd,
      agentName: run.agent.name,
      skills: [
        ...new Set([...run.agent.skills, ...includedAgents(run.agent, ctx.agents).flatMap((x) => x.agent.skills)]),
      ],
      resume: run.resume,
      params: run.params,
    },
    confirm,
    {
      cwd: run.cwd,
      progress: (server, tool, text) => {
        if (pluginProgress(task, server, tool, text)) ctx.changed()
      },
      // 每次调用现取：用户在这一轮里插的话也算（插件接口 17）
      userWords: () =>
        userWordsOf(task).map((w) => ({ text: w.text, at: w.at, ...(w.quoted ? { quoted: true } : {}) })),
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
