import { getLang, type Lang } from './i18n.ts'

/**
 * 交给 Agent 的回复语言规则：跟随面板设置里的界面语言（auto 的解析见 shared/i18n.ts 的 resolveLang、
 * 服务端的 server/lang.ts），在每次拼提示词时现算——设置里切换语言后下一次运行就是新语言，
 * 不用重启、也不用重新同步角色定义（所以不写进 Agent 的定义本身）。
 * 提示词是给 Agent 的指令，不写进 shared/locales（那边是界面文案）。
 */

const RULES: Record<Lang, string> = {
  zh: `## 回复语言
界面语言设成了中文：回复正文和你自己的思考过程（reasoning / thinking）都用中文。
代码、标识符、命令、日志和报错原文保持原样，不翻译。
即使系统提示词、工具输出或文件内容是别的语言，也按这里的要求做。`,
  en: `## Reply language
The panel language is set to English: write both your reply and your own reasoning / thinking in English.
Keep code, identifiers, commands, logs and error messages exactly as they are; do not translate them.
This still applies when the system prompt, tool output or files are in another language.`,
}

/**
 * 一句话的提醒：放在提示词末尾和执行中的补充里。
 * 长提示词里夹在中间的规则容易被忽略（实测 Command Code + DeepSeek 仍按英文系统提示词思考），
 * 末尾和每次新消息里再说一次；完整规则仍用 promptLangRules
 */
const REMINDERS: Record<Lang, string> = {
  zh: '回复正文和思考过程继续用中文；代码、命令、日志和报错原文不翻译。',
  en: 'Keep writing both your reply and your reasoning / thinking in English; keep code, commands, logs and error messages exactly as they are.',
}

export function promptLangReminder(lang: Lang = getLang()): string {
  return REMINDERS[lang]
}

/** 运行时按这个环境变量选规则（server/exec/prompt-lang-mod.ts 传给 CLI） */
export const PROMPT_LANG_ENV = 'AGENT_PANEL_REPLY_LANG'

/**
 * 给 Command Code 这类只能用 mod / 插件追加系统提示词的 CLI 用的插件源码：内容固定（两种语言都带上），
 * 运行时按 PROMPT_LANG_ENV 取规则，所以切换语言不用重写文件
 */
export function promptLangModSource() {
  const rules = { zh: promptLangRules('zh'), en: promptLangRules('en') }
  return `// 由 Agent 面板生成：把回复语言规则追加到 Command Code 的系统提示词，不要手改
const RULES = ${JSON.stringify(rules)}
export default function (cmd) {
  cmd.hooks({ appendSystemPrompt: () => RULES[process.env.${PROMPT_LANG_ENV}] || '' })
}
`
}

/** 完整的「回复语言」一节；lang 不传就用当前设置（浏览器或服务端已经解析过的那个） */
export function promptLangRules(lang: Lang = getLang()): string {
  return RULES[lang]
}

/**
 * 把「回复语言」一节插在提示词的第一段之后。
 * 不放在最前面：识别这类提示的地方（scripts/fake-cli 按第一句开头判断是哪个流程）靠开头匹配，
 * 开头被插进一段规则就认不出来了；放在前面又比放末尾更容易被遵守，所以在第一段之后
 */
export function withPromptLangRules(prompt: string, lang: Lang = getLang()): string {
  const at = prompt.indexOf('\n\n')
  if (at < 0) return `${prompt}\n\n${promptLangRules(lang)}`
  return `${prompt.slice(0, at)}\n\n${promptLangRules(lang)}${prompt.slice(at)}`
}

/**
 * 嵌在中文提示语句里的语言名：「完成后用中文简要总结」/「用英文写结果」。
 * 提示词正文本身仍是给 Agent 的中文指令，只有要求「用什么语言写」的地方跟着设置走
 */
export function promptLangWord(lang: Lang = getLang()): string {
  return lang === 'zh' ? '中文' : '英文'
}

/**
 * 结论行的写法。结论靠固定说法识别（engine.ts 的 parseVerdict 中文、英文两种都认），
 * 所以两种写法都告诉 Agent：回复用英文时写 Verdict: pass / fail 也能识别，不会因为语言换了就丢结论。
 * 中文那句的措辞不要改（`最后单独一行写「验收结论…`、`「结论：通过」或「结论：不通过」`）：
 * scripts/fake-cli 按这两个片段模拟 CLI 给出的验收结论，端到端测试靠它验证验收轮次和条件连线。
 */
export const VERDICT_LINE = {
  review: '单独一行写「验收结论：通过」或「验收结论：不通过」（回复用英文时写「Verdict: pass」或「Verdict: fail」）',
  branch: '单独一行写「结论：通过」或「结论：不通过」（回复用英文时写「Verdict: pass」或「Verdict: fail」）',
} as const
