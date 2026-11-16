/**
 * 提问弹窗的排版（用户 2026-11-16 选的方案 A）：把 AI 写的问题拆成「一句话问题 / 为什么问 / 折叠的细节」，
 * 把选项说明拆成「选了会怎样 / 和已定要求的 ✓✕ 对照」。
 *
 * CLI 自带的提问工具（Claude Code 的 AskUserQuestion）只有 question 和 options[label, description]，
 * 所以格式靠约定写进文字里（约定见 ASK_FORMAT），面板在这里拆；不按约定写的旧问题也能显示，只是重点没那么突出。
 * 拆分逻辑放 shared：界面和演示后端用同一份
 */

/** 提问的写法：提示词、技能、ask_user 的说明都引用这一份，改格式只改这里 */
export const ASK_FORMAT =
  '问题这样写：question 第一句就是要用户定的那件事（一句话，问号结尾，不写现状）；空一行再用一两句说为什么要问；' +
  '核查过程、命令输出、文件清单这类证据放进 <details>…</details>，默认折叠。正文里不要再列一遍选项，也不写「请选一种」。' +
  '每题 2–4 个选项：label 是动词开头的短做法，推荐的放第一位并在末尾标「（推荐）」；description 第一行写选了会怎样（结果，不是步骤），' +
  '和用户已定的要求对照时每条单独一行，以 ✓（符合）或 ✕（冲突）开头。「自己输入」由面板加，不用写成选项。'

/** 选项名结尾的「（推荐）」「(Recommended)」：AI 用它标出建议的那一项 */
const RECOMMENDED = /\s*[（(](?:推荐|建议|Recommended)[)）]\s*$/i

/** 一行 ✓ / ✕ 对照：前面可以带列表符号 */
const CHECK = /^\s*(?:[-*]\s+)?([✓✔☑]|[✕✗✘×❌])\s*(.+?)\s*$/

/** 背景超过这么多字就收进细节：背景只该是一两句，长了说明 AI 把证据写进了正文 */
const CONTEXT_MAX = 200

export interface AskLayout {
  /** 一句话问题（Markdown，可能带行内代码） */
  title: string
  /** 为什么问，一两句；没有就是空 */
  context: string
  /** 折叠起来的核查细节（Markdown）；没有就是空 */
  details: string
}

/** 拆问题正文：<details> 里的和过长的背景进细节，第一段是问题，其余是背景 */
export function askLayout(question: string): AskLayout {
  const folded: string[] = []
  const rest = question
    .replace(/<details[^>]*>([\s\S]*?)(?:<\/details>|$)/gi, (_, inner: string) => {
      folded.push(inner.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, '').trim())
      return '\n\n'
    })
    .trim()
  const paras = rest
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  // 第一段当标题：去掉 AI 习惯加的标题井号和整段加粗，标题行本来就是粗体
  const title = (paras.shift() ?? '').replace(/^#{1,6}\s+/, '').replace(/^\*\*([^*]+)\*\*$/, '$1')
  let context = ''
  // 列表、以冒号结尾的引子（「现状：」）不是背景，和后面的证据一起折叠
  const lead = paras[0] ?? ''
  if (lead && lead.length <= CONTEXT_MAX && !/^(?:[-*]|\d+[.、)])\s/.test(lead) && !/[:：]$/.test(lead))
    context = paras.shift()!
  return { title, context, details: [...paras, ...folded].filter(Boolean).join('\n\n') }
}

export interface OptionLayout {
  /** 去掉「（推荐）」后的选项名 */
  name: string
  /** 选了会怎样 */
  effect: string
  /** 和已定要求的对照 */
  checks: { ok: boolean; text: string }[]
}

/** 拆一个选项：说明里 ✓ / ✕ 开头的行是对照，其余是结果 */
export function optionLayout(label: string, description = ''): OptionLayout {
  const rec = RECOMMENDED.exec(label)
  const effect: string[] = []
  const checks: OptionLayout['checks'] = []
  for (const line of description.split('\n')) {
    const m = CHECK.exec(line)
    if (m) checks.push({ ok: /[✓✔☑]/.test(m[1]), text: m[2] })
    else if (line.trim()) effect.push(line.trim())
  }
  return { name: rec ? label.slice(0, rec.index).trim() : label, effect: effect.join(' '), checks }
}

/** 推荐的是第几个选项：先认 recommended 字段，没有再认 label 末尾的「（推荐）」；都没有是 -1 */
export function recommendedIndex(q: { recommended?: number; options: { label: string }[] }): number {
  const i = q.recommended
  if (typeof i === 'number' && i >= 0 && i < q.options.length) return i
  return q.options.findIndex((o) => RECOMMENDED.test(o.label))
}

/**
 * 只能传字符串选项的通道（子对话 message_parent、收尾建议）：第一行是做法，后面几行当说明（结果、✓✕ 对照）。
 * 回答只交第一行，换行后的说明不进答案
 */
export function splitOption(text: string): { label: string; description: string } {
  const [label = '', ...rest] = text.split('\n')
  return { label: label.trim(), description: rest.join('\n').trim() }
}
