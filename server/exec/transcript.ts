import type { Task, ToolUse } from '../../shared/schema.ts'
import { classifyError } from '../../shared/alerts.ts'
import { withAttachments } from '../../shared/task.ts'
import { clip } from '../../shared/text.ts'
import { t } from '../../shared/i18n.ts'

// 把对话整理成文字带给新会话：撤回 / 分叉后的续接、上下文超长后的裁剪降级。
// 从 runner.ts 拆出来：纯函数，不碰进程和会话，单测直接测

/** 估算一段文字的 token 数：中日韩字符约一个字一个 token，其余约四个字符一个 token。只用于显示实时速度 */
export function estTokens(s: string) {
  const cjk = s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0
  return cjk + (s.length - cjk) / 4
}

/** 对话撤回、分叉后 CLI 不能截断会话时，把留下的对话整理成文字带给新会话 */
export function transcript(task: Task, upto: number) {
  const lines: string[] = []
  for (const m of task.messages.slice(0, upto)) {
    if (m.step || m.role === 'system' || !m.text.trim()) continue
    const text = m.role === 'user' ? withAttachments(m.text, m.attachments) : m.text
    // 父对话交代的任务、回答 role 也是 user：说清是父对话说的，新会话别当成用户的话
    const who = m.role === 'user' ? (m.peer ? `父对话「${m.peer.title || m.peer.name}」` : '用户') : '你'
    lines.push(`${who}：${text.trim()}`)
  }
  return lines.join('\n\n')
}

/** 上下文超长降级时带给新会话的对话最多占模型窗口的多少：剩下的留给角色设定、提示词和这一轮的要求 */
export const CONTEXT_CARRY_SHARE = 0.4
/**
 * 正文至少要有这么多 token 才值得截断保留，不够就换成一行「正文太长，这里省略」：
 * 再短的话截出来的头尾只剩几个字，不如把预算留给工具行和更近的消息
 */
export const MIN_CLIP_TOKENS = 200

/**
 * 一轮以「上下文超长」失败时怎么自救：
 * - `compact`：这一次是压缩请求。压缩本身要把历史整段重发，模型照样会拒，改用面板裁剪的记录当摘要，按压缩成功返回
 * - `restart`：普通一轮。丢掉旧会话、把对话裁剪到预算内换成新会话接着做
 * - `null`：不自救，照原来的失败处理。已经降过一次（`retried`）就如实报错，不能无限重开；
 *   预热请求不碰对话记录；用户已经停了；这一轮本来没有可裁剪的历史
 *
 * 只认「上下文超长」这一种报错：别的 400 和网络错误各有自己的处理路径，不能被这里顺手改写
 */
export function contextFallbackKind(input: {
  detail: string
  retried: boolean
  prewarm: boolean
  aborted: boolean
  compact: boolean
  /** 这一轮是带历史的对话续接：只有这样的轮次才有旧会话可丢、有记录可裁剪 */
  chatResume: boolean
}): 'compact' | 'restart' | null {
  if (input.retried || input.prewarm || input.aborted) return null
  if (classifyError(input.detail) !== 'context') return null
  if (input.compact) return 'compact'
  return input.chatResume ? 'restart' : null
}

/** 按估算的 token 数截断一段文字：留开头和结尾，中间省略（结论通常在这两处） */
function clipTokens(s: string, budget: number) {
  const est = estTokens(s)
  if (est <= budget) return s
  // 省略标记本身也占预算：先扣掉它（按最长的数字估），截出来的整段才真的在预算以内
  const marker = (n: number) => `\n\n…（中间省略 ${n} 个字）…\n\n`
  const room = Math.max(0, budget - estTokens(marker(s.length)))
  // estTokens 对中日韩按字数、其余按四分之一字数估算，按比例折成字符数足够近似
  const keep = Math.max(80, Math.floor((s.length * room) / est))
  const head = Math.floor(keep * 0.6)
  return `${s.slice(0, head)}${marker(s.length - keep)}${s.slice(-(keep - head))}`
}

const TOOL_WORD: Record<ToolUse['kind'], string> = {
  read: '读取',
  edit: '修改',
  run: '运行',
  search: '搜索',
  web: '联网',
  skill: '技能',
  agent: '子对话',
  compact: '压缩',
  other: '工具',
}
/** 最近几条消息的工具调用保留完整；更早的只按类别计数（走时间越久越简，不然旧细节占掉大半预算） */
const RECENT_CLIP_ITEMS = 4
/** 一条消息最多列几项工具调用：再多就折成「等 N 项」，否则工具行自己会把预算吃光 */
const MAX_CLIP_TOOLS = 8
/** 工具标签（文件名、命令原文）最多留这么多字：够认出来做了什么，又不会一个标签就吃光一条消息的预算 */
const MAX_CLIP_TOOL_LABEL = 120

/** 一条消息里的工具调用（包括面板 MCP 工具：派子对话、后台命令、计划、传话）压成一行。 */
function toolLine(tools: ToolUse[]) {
  // 先去重再截：「等 N 项」按去重后还剩几项算，重复调用同一个文件不能把数字撑大
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tools) {
    const name = t.name?.trim() || TOOL_WORD[t.kind]
    const label = clip(t.label.trim(), MAX_CLIP_TOOL_LABEL)
    const one = label ? `${name} ${label}` : name
    if (seen.has(one)) continue
    seen.add(one)
    unique.push(t.failed ? `${one}（失败）` : one)
  }
  const items = unique.slice(0, MAX_CLIP_TOOLS)
  if (unique.length > MAX_CLIP_TOOLS) items.push(`等 ${unique.length - MAX_CLIP_TOOLS} 项`)
  return items.length ? `（工具：${items.join('；')}）` : ''
}

/** 很久以前那几条消息的工具调用：只按类别计数（读过哪些文件已经不重要，做过哪类事还在） */
function briefToolLine(tools: ToolUse[]) {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const word = TOOL_WORD[t.kind]
    const key = t.failed ? `${word}（失败）` : word
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const items = [...counts].map(([word, n]) => `${word}×${n}`)
  return items.length ? `（早先的工具：${items.join('；')}）` : ''
}

/**
 * 上下文已经超过模型上限时的续接内容：把对话裁剪到 token 预算之内。
 * 原来的历史已经证明发不出去（请求被 400 拒绝），带给新会话的文字必须自己受预算约束：
 * 从最新的消息往前留，更早的折成一行说明，单条过长的正文截断成头尾两段。
 * 工具调用行优先占预算：正文放不下时让位给工具，工具本身也放不下才整条省略；
 * 工具本身按时间分层：最近几条保留完整（文件名、命令原文），更早的只压成类别计数。
 * 面板 MCP 工具清单本身不靠这段文字：开新会话时 orchHint 会重新注入，这里只保留调用记录
 */
export function clippedTranscript(task: Task, upto: number, budget: number) {
  const items: { who: string; text: string; tools: string }[] = []
  const all = task.messages.slice(0, upto).filter((m) => !m.step && m.role !== 'system' && m.text.trim())
  for (const [i, m] of all.entries()) {
    const text = m.role === 'user' ? withAttachments(m.text, m.attachments) : m.text
    const who = m.role === 'user' ? (m.peer ? `父对话「${m.peer.title || m.peer.name}」` : '用户') : '你'
    // 最近几条看得见细节，更早的按「做过哪类事」计数就够
    const brief = i < all.length - RECENT_CLIP_ITEMS
    items.push({ who, text: text.trim(), tools: brief ? briefToolLine(m.tools) : toolLine(m.tools) })
  }
  const kept: string[] = []
  let used = 0
  let omitted = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const { who, text, tools } = items[i]
    const toolCost = tools ? estTokens(tools) : 0
    const left = budget - used
    // 连工具行都放不下：这一条和更早的消息一起省略（不能只留正文丢工具）
    if (toolCost > left) {
      omitted = i + 1
      break
    }
    const room = left - toolCost
    const line = `${who}：${text}`
    let body: string
    if (estTokens(line) <= room) body = line
    // 截断正文时要扣掉「谁说的」前缀：父对话的前缀带着标题，可能有几十个字
    else if (room - estTokens(`${who}：`) >= MIN_CLIP_TOKENS)
      body = `${who}：${clipTokens(text, room - estTokens(`${who}：`))}`
    // 正文挤不下就让它让位：工具调用照留，新会话至少知道这一轮做了什么
    else body = `${who}：（正文太长，这里省略，这一轮做了什么见下面的工具）`
    kept.unshift(tools ? `${body}\n${tools}` : body)
    used += estTokens(body) + toolCost
  }
  const head = omitted > 0 ? t('（更早的 {n} 条消息因为太长省略了）', { n: omitted }) : ''
  return [head, ...kept].filter(Boolean).join('\n\n')
}

/** 新会话接手旧对话：先压缩上下文，再继续；已经做完的不要重做 */
export function carryPrompt(task: Task, upto: number) {
  return [
    '## 之前的对话',
    transcript(task, upto),
    '',
    '请先把上面的对话压缩成继续任务需要的上下文摘要（要做的事、已经完成的工作、关键决定和原因、还没做完的部分），',
    '再完成「现在的要求」；已经做完的不要重做。',
  ].join('\n')
}
