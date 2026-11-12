/**
 * 交给 CLI 的这一轮输入：调用方给的提示，加上执行中的补充、/命令展开、带过去的对话、编排说明、Bug 流程、
 * 项目教训、角色设定和末尾的语言提醒。从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）
 */
import { createHash } from 'node:crypto'
import type { Agent } from '../../shared/schema.ts'
import type { getCli } from '../../shared/clis.ts'
import { NODE_PART } from '../../shared/engine.ts'
import type { AgentCall } from '../../shared/engine/host.ts'
import { defaultChatPrompt } from '../../shared/agent-role.ts'
import { trustFor } from '../../shared/cli/trust.ts'
import { promptLangReminder } from '../../shared/prompt-lang.ts'
import { lessonsPrompt } from '../../shared/lessons.ts'
import { experiencePrompt } from '../../shared/experience.ts'
import { slashInput } from '../slash.ts'
import { orchHint } from '../orch-mcp.ts'
import { readGlobalLessons } from '../lessons.ts'
import type { taskFiles } from '../task-files.ts'
import { notes } from './steering.ts'
import { SUMMARY_PROMPT, reviewPrompt } from './op-prompts.ts'
import { bugMethodPrompt, bugSlash } from './bug-prompt.ts'
import type { RealContext } from './real-context.ts'

export interface ComposeInputArgs {
  ctx: RealContext
  call: AgentCall
  def: NonNullable<ReturnType<typeof getCli>>
  cliId: string
  cwd: string
  chat: boolean
  step: string
  /** 续接的会话：没有就是新会话 */
  resume: string | undefined
  /** 开新会话时带过去的之前的对话 */
  carry: string
  /** 角色设定（含进系统提示词的规则） */
  instructions: string
  taskDir: Awaited<ReturnType<typeof taskFiles>>
  /** 执行这一轮的角色 */
  found: Agent
}

export async function composeInput(a: ComposeInputArgs) {
  const { ctx, call, def, cliId, cwd, chat, step, resume, carry, instructions, taskDir, found } = a
  const { task, settings, project } = ctx
  const { agentId, prompt, sessionKey, op } = call
  // 调用方只发了增量（续接时省掉会话里已有的规则段落）、这次却没接上原来的会话（换了 CLI / 目录、回退、续不上）：
  // 新会话里什么都没有，改用完整的提示
  const base = !resume && call.fresh ? call.fresh : prompt
  let input = op?.kind === 'review' && def.review !== 'native' ? reviewPrompt(op.target) : base
  input = defaultChatPrompt(input, !!(agentId || found.instructions), chat, !!op)
  // 之前的节点收不了的补充，交给这个节点
  const pending = step ? notes.get(task.id) : undefined
  if (pending?.length) {
    notes.delete(task.id)
    input = `${input}\n\n## 用户在执行中补充的信息\n${pending.join('\n\n')}`
  }
  if (op?.kind === 'compact') input = def.compact === 'slash' ? '/compact' : SUMMARY_PROMPT
  // 对话里打的「/命令」：展开成普通要求，插件命令这一轮原样只发这一句（见 server/slash.ts 的 slashInput）
  const slash =
    !chat || op
      ? undefined
      : await slashInput(input, ctx.prompt, {
          cli: cliId,
          cwd,
          native: def.slash && !carry,
          trust: trustFor(def, ctx.project),
          bug: bugSlash(ctx.prompt, task, !!call.orch?.coordinator),
        })
  if (slash) input = slash.input
  if (carry) input = `${carry}\n\n## 现在的要求\n${input}`
  // 工作流里的调用带上编排工具（派子 Agent、查状态、提问、传话）；第一轮告诉它什么时候用，续接的会话里已经说过
  const orch = call.orch && def.mcp && !op ? call.orch : undefined
  // Chat 模式没有后台命令时说明是空的，不拼空行
  const hint = orch && !resume ? orchHint(orch) : ''
  if (hint) input = `${input}\n\n${hint}`
  // 用户报的 Bug：新会话第一轮带上完整查找流程（ADR 0046）
  const bugMethod = !op && bugMethodPrompt(task, ctx.prompt, !resume)
  if (bugMethod) input = `${input}\n\n${bugMethod}`
  // 升级成 Bug 后补带的完整流程只带一次（这一轮是 /bug 时展开里已经带了，一样算带过）
  if (!op && task.bug?.methodPending) task.bug.methodPending = undefined
  // 项目教训：新会话开头带一次（全局条目全文 + 其余标题），按文件的全文由 Agent 用 project_lessons 自己取；
  // 子任务只查不记，不带记教训的说明
  if (!resume && !op && task.projectId) {
    const globals = await readGlobalLessons()
    const lessons = lessonsPrompt(project.lessons ?? [], !!orch?.lessons, globals, !!orch?.lessons?.record)
    // 项目经验只放一行「有几条、怎么查」，按需求原文本地匹配到的最多附两条（shared/experience.ts）
    const exp =
      orch?.experience && experiencePrompt(await orch.experience.list(), ctx.prompt, settings.experience.preHint)
    for (const part of [lessons, exp]) if (part) input = `${input}\n\n${part}`
  }
  // 没有系统提示词参数的 CLI：对话目录的规则接在新会话的任务描述后面（有参数的已经放进系统提示词）
  if (!resume && !op && !def.systemPromptFlag) input = `${input}\n\n${taskDir.rule}`
  // 没有系统提示词参数的 CLI 只在会话第一轮带角色设定。续接旧会话时角色变了（内置角色随版本更新、用户改了设定），
  // 把新版补发一次，旧对话再聊也按新角色做；以前开的会话没记过，按变了处理补一次
  const roleHash = instructions ? createHash('sha1').update(instructions).digest('hex').slice(0, 16) : ''
  const roleStale = !!resume && !op && !!roleHash && task.roleHashes?.[sessionKey] !== roleHash
  // 记录被压缩清掉的（见 forgetPromptSent）：角色没变，只是会话里只剩摘要，原样重发
  if (instructions && !def.systemPromptFlag && roleStale)
    input = task.roleHashes?.[sessionKey]
      ? `## 你的角色（已更新，以这一版为准，之前的角色设定作废）\n${instructions}\n\n${input}`
      : `## 你的角色\n${instructions}\n\n${input}`
  if (instructions && !def.systemPromptFlag && (!resume || roleStale))
    task.roleHashes = { ...task.roleHashes, [sessionKey]: roleHash }
  if (instructions && !def.systemPromptFlag && !resume) {
    // 节点的角色设定放在各节点共用的部分（需求、工作流说明）后面：不同 Agent 的节点开头一样，按前缀匹配的缓存能命中
    const role = `## 你的角色\n${instructions}\n\n`
    const at = step ? input.indexOf(`\n\n${NODE_PART}\n`) : -1
    input = at < 0 ? role + input : `${input.slice(0, at + 2)}${role}${input.slice(at + 2)}`
  }
  if (slash?.raw) input = slash.raw
  const setup = input.length - base.length
  // 末尾再提醒一次：长提示词里夹在中间的规则容易被忽略。原生 /命令（Claude Code 新会话开头要原样认出）
  // 和压缩、审查（参数另有含义）不追加
  if (!op && !(chat && ctx.prompt.trim().startsWith('/'))) input = `${input}\n\n${promptLangReminder()}`
  // 输入构成：除了调用方给的提示，新会话开头补的角色设定（含系统提示词）、编排说明、项目教训也进了上下文；
  // 末尾的语言提醒每轮都有，算进面板规则
  call.onInput?.({
    setup: Math.max(0, setup) + (!resume && def.systemPromptFlag ? instructions.length : 0),
    rules: Math.max(0, input.length - base.length - setup),
    fresh: base !== prompt,
  })
  return { input, orch }
}
