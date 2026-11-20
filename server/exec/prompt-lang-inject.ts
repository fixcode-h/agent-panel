/**
 * 「回复正文和思考过程用哪种语言」的唯一注入点：所有调起 CLI 的地方（对话、子对话、子任务、工作流节点、
 * Bug 模式、经验提炼、AI 创建、插件发起的调用……）最终都经过 invokeCli，规则就在那里统一补上，
 * 调用方不再各自拼。
 *
 * 为什么要三处都补：
 * - 系统提示词：模型的原生思考主要跟系统提示词走，只写在任务描述里时常常不遵守（实测 Command Code + DeepSeek）。
 *   以前只有 runner 起的对话把规则放进系统提示词，invokeCli 的其他调用方（经验提炼、AI 创建、插件）没有。
 * - 第一轮输入的末尾：长提示词里夹在中间的规则容易被忽略。
 * - 保活进程的后续每一轮：以前只在第一轮末尾提醒，之后交给同一进程的消息原样转过去。子对话收到的多是父对话的传话、
 *   子任务交回的结果（不按「用户这次的消息」补状态），一长串英文命令输出之后思考就换成英文（用户 2026-11-20 报）。
 */
import { PROMPT_LANG_ENV, promptLangReminder, promptLangRules, replyLang } from '../../shared/prompt-lang.ts'
import type { BuildOptions, CliDefinition } from '../../shared/clis.ts'
import { ensurePromptLangMod } from './prompt-lang-mod.ts'

/**
 * 把语言规则放进系统提示词：有系统提示词参数的 CLI 接在角色设定后面（没有角色设定时单独一段），
 * 只能靠 mod 追加的（Command Code）装上语言 mod，并用环境变量告诉它当前语言。
 * 只要一段文字的小活（textOnly，起标题）换成了极简系统提示，不加
 */
export async function withLangSystemPrompt(
  def: Pick<CliDefinition, 'systemPromptFlag' | 'systemPromptMod'>,
  build: BuildOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ build: BuildOptions; env: NodeJS.ProcessEnv }> {
  if (build.textOnly) return { build, env }
  if (def.systemPromptFlag) {
    const rules = promptLangRules()
    if (!build.systemPrompt?.includes(rules))
      build = { ...build, systemPrompt: [build.systemPrompt?.trim(), rules].filter(Boolean).join('\n\n') }
  } else if (def.systemPromptMod && !build.systemPromptModPath) {
    build = { ...build, systemPromptModPath: await ensurePromptLangMod() }
  }
  // mod 按这个环境变量选语言规则（见 prompt-lang-mod.ts）
  if (build.systemPromptModPath) env = { ...env, [PROMPT_LANG_ENV]: replyLang() }
  return { build, env }
}

/**
 * 在交给 CLI 的一段输入末尾放语言提醒：已经有的（调用方拼过、后面又接了用法说明）挪到最后，没有就补上。
 * 原生 /命令（CLI 要在开头原样认出）不加；skip 给压缩、审查这类参数另有含义的操作
 */
export function withLangReminder(input: string, skip = false): string {
  if (skip || input.trimStart().startsWith('/')) return input
  const remind = promptLangReminder()
  const at = input.lastIndexOf(`\n\n${remind}`)
  const body = at >= 0 ? `${input.slice(0, at)}${input.slice(at + 2 + remind.length)}` : input
  return body.trim() ? `${body}\n\n${remind}` : input
}

/**
 * 保活进程的下一轮（面板保活、模型自己调 wait_user_message 等到的）：交过去之前同样补上语言提醒。
 * 用户的消息、父对话的传话、子任务交回的结果都走这里
 */
export function withLangNextTurns<T extends { waitUser?: NextTurn; keepAlive?: NextTurn }>(o: T) {
  const wrap = (f?: NextTurn) => f && (async () => ((t) => (t === null ? t : withLangReminder(t)))(await f()))
  return { waitUser: wrap(o.waitUser), keepAlive: wrap(o.keepAlive) }
}

type NextTurn = () => Promise<string | null>
