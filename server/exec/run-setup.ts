// runAgent 开跑前的准备（重构文档第 3 条：按阶段拆 runAgent）：
// resolveTarget 定下这次用哪个角色、哪个 CLI、哪个模型和目录（不能跑就给出原因），
// prepareLaunch 拼角色设定、这一轮的输入和启动参数，并把启动命令记到任务 / 节点上。
// 这两步只读任务和设置、不碰 RunState，失败也不会留下半截状态。
import { stat } from 'node:fs/promises'
import { aliasAgent } from '../../shared/schema.ts'
import { getCli } from '../../shared/clis.ts'
import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import { withTaskModel } from '../../shared/tasks/run.ts'
import { composeRole, includedAgents, nodeAgentRun } from '../../shared/agent-role.ts'
import { fillSkills } from '../../shared/expose.ts'
import { withSkillDir } from '../../shared/skill-guide.ts'
import { turnRole } from '../../shared/conv-mode.ts'
import { promptLangRules, promptUserNameRules } from '../../shared/prompt-lang.ts'
import type { AgentCall } from '../../shared/engine-host.ts'
import { t } from '../../shared/i18n.ts'
import { ensureBundled, sharedRoot } from '../bundled-skills.ts'
import { taskFiles } from '../task-files.ts'
import { log } from '../log.ts'
import type { RealContext } from './real-context.ts'
import { resolveModelRun } from './model-run.ts'
import { composeInput } from './compose-input.ts'
import { launchOptions } from './launch-options.ts'
import { ensurePromptLangMod } from './prompt-lang-mod.ts'
import { pluginRunTools } from './plugin-run.ts'
import type { createFileEvents } from './file-events.ts'

/** 定下这次调用的角色、CLI、目录和模型；不能跑时给出写给用户的原因 */
export async function resolveTarget(ctx: RealContext, call: AgentCall) {
  const { agentId } = call
  const { task, settings, project } = ctx
  // agentId 为空表示这个对话不用 Agent 角色：直接用默认 CLI，不注入角色设定
  // 旧快照里记着已经合并删掉的角色时，按登记的转到合并目标（转成空就是不用角色）；Chat 页选的角色被删了按内置助手跑（turnRole）
  const id = ctx.agents.some((a) => a.id === agentId) ? agentId : aliasAgent(agentId)
  const found = turnRole(ctx.task, ctx.agents, id)
  if (!found) return { error: t('找不到执行这一步的角色，可能已被删除') }
  if (id && found.id !== id) log.info('agent', 'Chat 对话的角色已被删除，按内置助手跑', { task: task.id, agentId: id })
  // 工作流里的调用固定用默认 CLI 的档位；对话可以用 Agent 自己的 CLI，默认 Agent 还能临时换模型
  const agent =
    call.tier !== undefined ? nodeAgentRun(found, call.tier, defaultCli(settings)) : withTaskModel(found, task)
  const run = agentRun(agent, settings)
  const cliId = run.cli
  const def = getCli(cliId)
  if (!def) return { error: t('未知的 Agent：{cli}', { cli: cliId }) }
  const cs = cliSettings(settings, cliId)
  if (!cs.enabled) return { error: t('{cli} 在设置里被停用了', { cli: def.name }) }
  if (!agent.enabled) return { error: t('角色「{name}」已停用', { name: agent.name }) }
  const cwd = project.path
  const dir = await stat(cwd).catch(() => null)
  if (!dir?.isDirectory()) return { error: t('项目目录不存在：{dir}', { dir: cwd || t('（未设置）') }) }

  const model = run.model
  // 思考强度（模型不认的换掉或去掉）和上下文上限在 model-run.ts 算
  const { entries, requested, effort, manual, limits } = await resolveModelRun(cliId, run, cs)
  return { found, agent, cliId, def, cs, cwd, model, entries, requested, effort, manual, limits }
}

export type RunTarget = Exclude<Awaited<ReturnType<typeof resolveTarget>>, { error: string }>

/** 拼启动要用的角色设定、这一轮的输入和启动参数 */
export async function prepareLaunch(
  ctx: RealContext,
  call: AgentCall,
  target: RunTarget,
  o: {
    step: string
    chat: boolean
    op: AgentCall['op']
    resume: string | undefined
    fork: Parameters<typeof launchOptions>[0]['fork']
    carry: string
    windowFor: (model: string) => number
  },
) {
  const { task, settings } = ctx
  const { found, agent, cliId, def, cs, cwd, model, effort, limits } = target
  const { step, chat, op, resume, fork, carry, windowFor } = o
  const role = withSkillDir(
    composeRole(agent, ctx.agents, call.params ?? (step ? {} : task.params), task.skillSlots).trim(),
    sharedRoot(),
  )
  // 支持系统提示词的 CLI：语言规则跟角色设定一起放系统提示词。模型的原生思考主要跟系统提示词走，
  // 只写在任务描述里时不一定遵守（实测 Command Code + DeepSeek 仍按英文系统提示词思考）
  // 设置里的「称呼」也跟角色设定一起走：没有系统提示词参数的 CLI 改了称呼时角色段的哈希变了，会补发一次
  const taskDir = await taskFiles(task.id) // 对话目录：截图和临时文件放这里，规则进系统提示词（见 task-files.ts）
  const instructions = [
    role,
    def.systemPromptFlag ? promptLangRules() : '',
    promptUserNameRules(settings.userName),
    def.systemPromptFlag ? taskDir.rule : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  // Command Code 没有系统提示词参数，改用 --mod 加载的 mod 追加同一段规则（见 prompt-lang-mod.ts）
  const systemPromptModPath = def.systemPromptMod ? await ensurePromptLangMod() : undefined
  // Agent 要用的自带 Skill 统一补到 ~/.agents/skills，提示里点名的 Skill 才找得到
  await ensureBundled(
    fillSkills(
      [...new Set([...agent.skills, ...includedAgents(agent, ctx.agents).flatMap((x) => x.agent.skills)])],
      task.skillSlots,
    ),
  )
  // 这一轮交给 CLI 的输入（补充、/命令、带过去的对话、编排说明、教训、角色设定）在 compose-input.ts 里拼
  const composed = await composeInput({
    ctx,
    call,
    def,
    cliId,
    cwd,
    chat,
    step,
    resume,
    carry,
    instructions,
    taskDir,
    found,
  })
  // 启动参数和环境变量（自动压缩、上下文上限、放行的目录这些）在 launch-options.ts
  const { pct, build, env } = await launchOptions({
    ctx,
    def,
    cs,
    agent,
    model,
    effort,
    limits,
    resume,
    fork,
    op,
    chat,
    instructions,
    systemPromptModPath,
    taskDir,
    cwd,
    windowFor,
  })

  // 记下这次启动的命令，任务页里可以复制出来自己跑一遍排查问题；角色设定很长，用占位代替
  const argv = [
    cs.command,
    ...def.buildArgs(build).map((a) => (build.systemPrompt && a === build.systemPrompt ? t('<角色设定>') : a)),
  ]
  const owner = step ? task.steps.find((s) => s.id === step) : undefined
  if (owner) owner.command = argv
  else task.command = argv
  log.info('agent', `启动 ${def.name}`, { task: task.id, step, agent: agent.name, cwd, command: argv.join(' ') })

  return { instructions, input: composed.input, orch: composed.orch, pct, build, env, owner }
}

/**
 * 插件给 Agent 的工具（ADR 0059）：开着的插件按这轮对话决定挂不挂，新会话的提示词里说明怎么用；令牌只在这一轮有效。
 * 插件改了的文件经 fileEvents 记成这一轮的改动
 */
export function attachPlugins(
  ctx: RealContext,
  call: AgentCall,
  who: {
    agent: RunTarget['agent']
    resume: string | undefined
    cwd: string
    step: string
    agentId: string
    conversation: boolean
  },
  fileEvents: ReturnType<typeof createFileEvents>,
) {
  const { agent, resume, cwd, step, agentId, conversation } = who
  return pluginRunTools(
    ctx,
    { agent, resume: !!resume, cwd, step, agentId, conversation },
    {
      // 插件的改文件类工具：执行前过工具前守卫（守卫在下面 hookOptions 里装到 call.orch 上，调用时才取），
      // 改了的文件和 CLI 自己的改文件工具一样记成这一轮的改动、登记归属
      guardEdit: async (tool, paths, input) => (await call.orch?.guardEdit?.(tool, paths, input)) ?? '',
      changed: (files) => {
        for (const f of files)
          fileEvents.track({ kind: 'edit', label: f, detail: '' }, { path: f, add: 0, del: 0 }, false)
      },
      // 插件的长任务交给面板的后台命令（插件框架改进 G1）：和 run_background 同一套监管，结果推回这个对话
      background: async (job) => {
        const orch = call.orch
        if (!orch?.canBackground) return { ok: false, info: '这个对话不能用后台命令：插件自己跑' }
        return orch.runBackground({
          command: String(job.command ?? ''),
          name:
            String(job.name ?? '').trim() ||
            String(job.command ?? '')
              .split('\n')[0]
              .slice(0, 40),
          cwd: String(job.cwd ?? ''),
          exclusive: job.exclusive === true,
          ...(Number(job.timeoutMinutes) > 0 && { timeoutMinutes: Number(job.timeoutMinutes) }),
        })
      },
    },
  )
}
