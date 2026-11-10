/**
 * 启动 CLI 的参数和环境变量：模型、强度、权限、续接 / 分叉、系统提示词、放行的目录、自动压缩、上下文上限。
 * 从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）；按 CLI 定义里的字段拼，不按 CLI 的名字分支
 */
import type { Agent } from '../../shared/schema.ts'
import type { BuildOptions, getCli } from '../../shared/clis.ts'
import type { AgentCall } from '../../shared/engine.ts'
import { agentPermission, type cliSettings } from '../../shared/settings.ts'
import { limitEnvVars, longContextModel, type ModelLimits } from '../../shared/model-limits.ts'
import { trustFor } from '../../shared/cli-trust.ts'
import { pluginArgs } from '../../shared/role-plugins.ts'
import { replyLang } from '../../shared/prompt-lang.ts'
import { attachmentAddDirs } from '../attachments.ts'
import { UPLOADS_DIR } from '../uploads.ts'
import { handoffDirOf } from '../store.ts'
import type { taskFiles } from '../task-files.ts'
import { noPushEnv } from './no-push.ts'
import { childEnv } from './process.ts'
import { PROMPT_LANG_ENV } from './prompt-lang-mod.ts'
import { searchExcludeEnv } from './search-exclude-env.ts'
import type { RealContext } from './real-context.ts'

export interface LaunchArgs {
  ctx: RealContext
  def: NonNullable<ReturnType<typeof getCli>>
  cs: ReturnType<typeof cliSettings>
  agent: Agent
  model: string
  effort: string | undefined
  limits: ModelLimits
  resume: string | undefined
  fork: BuildOptions['fork']
  op: AgentCall['op']
  chat: boolean
  instructions: string
  systemPromptModPath: string | undefined
  taskDir: Awaited<ReturnType<typeof taskFiles>>
  cwd: string
  windowFor: (model: string) => number
}

export async function launchOptions(a: LaunchArgs) {
  const { ctx, def, cs, agent, model, effort, limits, resume, fork, op, chat, instructions } = a
  const { systemPromptModPath, taskDir, cwd, windowFor } = a
  const { task, settings } = ctx
  // 自动压缩：Claude Code 用环境变量，Codex 用配置（按上下文窗口换算成 token 数）；Command Code 由面板在一轮结束后压缩
  const pct = cs.autoCompact
  const build: BuildOptions = {
    // API 方式下上下文窗口够大时按 CLI 定义加长上下文后缀（Claude Code 的 [1m]）：它认得出的自家模型只认这个，
    // 不看环境变量里的窗口。账号方式不加：账号的模型窗口 CLI 自己知道，有的套餐也用不了 1M，加了反而报错
    model: cs.api ? longContextModel(def, model, limits.context) : model,
    effort,
    permission: agentPermission(agent, settings),
    // 项目设置里信任了（或明确不信任）这个 CLI 的项目配置：按定义加参数（ADR 0050）
    trust: trustFor(def, ctx.project),
    extraArgs: [...cs.extraArgs, ...agent.extraArgs, ...pluginArgs(def, agent.plugins)],
    maxTurns: cs.maxTurns || undefined,
    resume,
    fork,
    // 审查走 CLI 自己的审查模式，压缩走协议；其余的已经换成普通的一轮
    op: (op?.kind === 'compact' ? def.compact : def.review) === 'native' ? op : undefined,
    systemPrompt: def.systemPromptFlag && instructions ? instructions : undefined,
    systemPromptModPath,
    // 图片附件拷在对话目录的 attachments/ 下（对话目录在下面一并放行）；其余按原来的绝对路径交给 Agent，
    // 工作目录之外的那些要放行。交接的完整结果在数据目录里，启动前就建好目录并放行（见 handoffDirOf）
    addDirs: [
      ...attachmentAddDirs(
        task.messages.flatMap((m) => m.attachments ?? []),
        { cwd, uploadsRoot: UPLOADS_DIR },
      ),
      handoffDirOf(task.id),
      // 对话目录在工作目录外：放行，Agent 才能读到拷进来的图片、把截图和临时文件写进去
      taskDir.dir,
    ],
    noEdit: chat && !!ctx.beginEdit,
    autoCompactTokens: pct && def.autoCompact === 'config' ? Math.floor((windowFor(model) * pct) / 100) : undefined,
    contextWindow: limits.context || undefined,
    maxOutput: limits.maxOutput || undefined,
    // 对话的标题交给能给会话起名的 CLI，在它自己的会话列表里认得出是哪个对话
    title: chat && task.title ? task.title : undefined,
  }
  const env = childEnv([
    ...cs.env,
    // mod 按它选语言规则（见 prompt-lang-mod.ts）
    ...(systemPromptModPath ? [{ key: PROMPT_LANG_ENV, value: replyLang() }] : []),
    ...(pct && def.autoCompact === 'env' && def.autoCompactEnv
      ? [{ key: def.autoCompactEnv, value: String(pct) }]
      : []),
    // 用户在环境变量里自己写了同名的，以设置里这一档的值为准（写在后面）
    ...limitEnvVars(def, limits),
    ...noPushEnv(task, ctx.project.gitPolicy),
    ...(await searchExcludeEnv(ctx)),
  ])
  return { pct, build, env }
}
