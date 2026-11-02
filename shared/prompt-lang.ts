import { getLang, isLangAuto, type Lang } from './i18n.ts'

/**
 * 交给 Agent 的回复语言规则：跟随面板设置里的界面语言（auto 的解析见 shared/i18n.ts 的 resolveLang、
 * 服务端的 server/lang.ts），在每次拼提示词时现算——设置里切换语言后下一次运行就是新语言，
 * 不用重启、也不用重新同步角色定义（所以不写进 Agent 的定义本身）。
 * 提示词是给 Agent 的指令，不写进 shared/locales（那边是界面文案）。
 */

/**
 * 交给 Agent 的回复语言：zh / en 是设置里明确选的；auto-* 是设置成「自动」，回复跟着用户这条消息的语言走，
 * 界面语言只管界面（系统语言是 C.UTF-8 时「自动」解析成英文，按界面语言回复会对中文提问答英文）。
 * 后缀是看不出语言时的兜底，也决定规则本身用哪种语言写
 */
export type ReplyLang = Lang | 'auto-zh' | 'auto-en'
export const replyLang = (): ReplyLang => (isLangAuto() ? `auto-${getLang()}` : getLang())

const RULES: Record<ReplyLang, string> = {
  zh: `## 回复语言
界面语言设成了中文：回复正文和你自己的思考过程（reasoning / thinking）都用中文。
代码、标识符、命令、日志和报错原文保持原样，不翻译。
即使系统提示词、工具输出或文件内容是别的语言，也按这里的要求做。`,
  en: `## Reply language
The panel language is set to English: write both your reply and your own reasoning / thinking in English.
Keep code, identifiers, commands, logs and error messages exactly as they are; do not translate them.
This still applies when the system prompt, tool output or files are in another language.`,
  'auto-zh': `## 回复语言
面板语言设成了「自动」：回复正文和你自己的思考过程（reasoning / thinking）都用用户这条消息（或交给你的任务说明）所用的语言——用户用中文写就用中文，用英文写就用英文；看不出来时（例如只有代码或命令）用中文。
代码、标识符、命令、日志和报错原文保持原样，不翻译。
即使系统提示词、工具输出或文件内容是别的语言，也按用户消息的语言回复。`,
  'auto-en': `## Reply language
The panel language is set to Auto: write both your reply and your own reasoning / thinking in the language the user's message (or the task you were given) is written in — Chinese if they wrote in Chinese, English if they wrote in English; if you cannot tell (e.g. it is only code or commands), use English.
Keep code, identifiers, commands, logs and error messages exactly as they are; do not translate them.
This still applies when the system prompt, tool output or files are in another language.`,
}

/**
 * 一句话的提醒：放在提示词末尾和执行中的补充里。
 * 长提示词里夹在中间的规则容易被忽略（实测 Command Code + DeepSeek 仍按英文系统提示词思考），
 * 末尾和每次新消息里再说一次；完整规则仍用 promptLangRules
 */
const REMINDERS: Record<ReplyLang, string> = {
  zh: '回复正文和思考过程继续用中文；代码、命令、日志和报错原文不翻译。',
  en: 'Keep writing both your reply and your reasoning / thinking in English; keep code, commands, logs and error messages exactly as they are.',
  'auto-zh': '回复正文和思考过程用用户这条消息所用的语言；代码、命令、日志和报错原文不翻译。',
  'auto-en':
    "Write both your reply and your reasoning / thinking in the language of the user's message; keep code, commands, logs and error messages exactly as they are.",
}

export function promptLangReminder(lang: ReplyLang = replyLang()): string {
  return REMINDERS[lang]
}

/** 运行时按这个环境变量选规则（server/exec/prompt-lang-mod.ts 传给 CLI） */
export const PROMPT_LANG_ENV = 'AGENT_PANEL_REPLY_LANG'

/**
 * 给 Command Code 这类只能用 mod / 插件追加系统提示词的 CLI 用的插件源码：内容固定（两种语言都带上），
 * 运行时按 PROMPT_LANG_ENV 取规则，所以切换语言不用重写文件
 */
export function promptLangModSource() {
  const rules = Object.fromEntries((Object.keys(RULES) as ReplyLang[]).map((k) => [k, promptLangRules(k)]))
  return `// 由 Agent 面板生成：把回复语言规则追加到 Command Code 的系统提示词，不要手改
const RULES = ${JSON.stringify(rules)}
export default function (cmd) {
  cmd.hooks({ appendSystemPrompt: () => RULES[process.env.${PROMPT_LANG_ENV}] || '' })
}
`
}

/** 完整的「回复语言」一节；lang 不传就用当前设置（浏览器或服务端已经解析过的那个） */
export function promptLangRules(lang: ReplyLang = replyLang()): string {
  return RULES[lang]
}

/**
 * 把「回复语言」一节插在提示词的第一段之后。
 * 不放在最前面：识别这类提示的地方（scripts/fake-cli 按第一句开头判断是哪个流程）靠开头匹配，
 * 开头被插进一段规则就认不出来了；放在前面又比放末尾更容易被遵守，所以在第一段之后
 */
export function withPromptLangRules(prompt: string, lang: ReplyLang = replyLang()): string {
  const at = prompt.indexOf('\n\n')
  if (at < 0) return `${prompt}\n\n${promptLangRules(lang)}`
  return `${prompt.slice(0, at)}\n\n${promptLangRules(lang)}${prompt.slice(at)}`
}

/**
 * 嵌在中文提示语句里的语言名：「完成后用中文简要总结」/「用英文写结果」。
 * 提示词正文本身仍是给 Agent 的中文指令，只有要求「用什么语言写」的地方跟着设置走
 */
export function promptLangWord(lang: ReplyLang = replyLang()): string {
  // 「自动」时也不能写死中文 / 英文，否则和「跟随用户消息」的规则打架
  return lang === 'zh' ? '中文' : lang === 'en' ? '英文' : '用户消息所用的语言'
}

/**
 * 要结论时的那句话（ADR 0041 第 16 节）：结论只认 submit_verdict 工具，不看回复里写了什么，语言换了也不影响。
 * 措辞里的「submit_verdict 工具交验收结论」「submit_verdict 工具交结论」不要改：
 * scripts/fake-cli 按这两个片段模拟 CLI 调工具交结论，端到端测试靠它验证验收轮次和条件连线。
 */
export const VERDICT_LINE = {
  review:
    '调用 submit_verdict 工具交验收结论：verdict 写 pass（通过）或 fail（不通过），不通过时 blockers 列出必须改的地方。面板只认这个工具，不看回复里写的字',
  branch:
    '调用 submit_verdict 工具交结论：verdict 写 pass（通过）或 fail（不通过）。面板只认这个工具，不看回复里写的字',
} as const

/**
 * 「怎么称呼用户」一节：设置里填了「称呼」才有，跟角色设定一起放（系统提示词或会话第一轮的角色段）。
 * 以前称呼只用在界面标签上（提问卡片「需要X回答」），Agent 不知道，回复和提问里仍写「你」「用户」（用户报的问题）。
 * 和语言规则一样每次拼提示词时现算：改了称呼，系统提示词下一轮就是新的；没有系统提示词参数的 CLI
 * 靠角色段的哈希变化补发（server/exec/runner.ts 的 roleStale）
 */
export function promptUserNameRules(name: string | undefined, lang: Lang = getLang()): string {
  const n = name?.trim()
  if (!n) return ''
  return lang === 'zh'
    ? `## 怎么称呼用户\n用户希望被称呼为「${n}」：回复里称呼用户、向用户提问（提问卡片的问题和选项说明）、给父对话转达要用户决定的事时，都用「${n}」来指代用户。`
    : `## How to address the user\nThe user wants to be called "${n}": use "${n}" whenever you address or refer to the user — in replies, in questions you ask them (question text and option descriptions), and when relaying decisions that need them to the parent conversation.`
}
