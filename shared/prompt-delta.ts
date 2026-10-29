/**
 * 续接会话时只发变了的提示词段落。
 *
 * 对话（父对话、子对话）每一轮都会重新拼一份完整的规则提示（授权、计划规则、执行目录、验证、分派规则……，
 * 实测 8–9 千字）。CLI 没保活时（子对话通常没人开着页面），父对话转达、合并结果、后台结果每来一次就开一轮，
 * 这一整份又原样追加进同一个会话：会话里堆着十几份一模一样的规则，每份都是不命中缓存的新输入，
 * 还把上下文推向压缩。会话里已经有的段落不用再发，只发这次新出现或内容变了的段落。
 *
 * 按拼提示词时的段落记指纹（键是段落的标题行，同名的按出现次序区分）。下面几种情况发完整提示：
 * 会话换了（新会话、CLI 自己丢了会话重开）、压缩过（runner 清掉记录）、续接了 FULL_EVERY 轮（规则离得太远，
 * 长上下文里容易被忽略，定期补一份完整的）。
 */
import { hash53 } from './hash.ts'

/** 每一轮都要发的段落（按标题行认）：这一轮的消息和随轮次变化的输入，不按指纹省 */
export const ALWAYS_SECTIONS = [
  '## 用户这次的消息',
  '## 子对话发来的消息',
  '## 要做的事',
  '## 这是重试',
  '## 接着上一次做',
]

/** 连续续接这么多轮之后补发一次完整提示 */
export const FULL_EVERY = 10

/** 一个会话已经收到过的段落指纹（Task.promptSent 的值） */
export interface PromptSent {
  /** 记录时的 CLI 会话 id：会话换了就整份重发 */
  session: string
  /** 段落键 → 指纹 */
  hashes: Record<string, string>
  /** 上一次发完整提示之后续接了几轮 */
  turns: number
}

export interface PromptSection {
  key: string
  text: string
}

/**
 * 拼提示词时的一段段内容 → 带键的段落。键是段落的第一行（标题），同名的按出现次序区分。
 * 不按全文里的「## 」重新切：用户消息、目标、子对话转来的文字里也可能有「## 」开头的行，切开后会被当成规则段落省掉
 */
export function promptSections(parts: string[]): PromptSection[] {
  const seen = new Map<string, number>()
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => {
      const head = text.split('\n', 1)[0].trim()
      const n = seen.get(head) ?? 0
      seen.set(head, n + 1)
      return { key: n ? `${head}#${n + 1}` : head, text }
    })
}

const always = (key: string) => ALWAYS_SECTIONS.some((h) => key === h || key.startsWith(`${h}#`))

/** 一份完整提示里要记住的段落指纹（每轮都发的不记） */
export function sectionHashes(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of promptSections(parts)) if (!always(s.key)) out[s.key] = hash53(s.text)
  return out
}

/**
 * 续接会话时要发的提示：只留每轮都发的段落、新出现的和内容变了的；不能省时返回 null（发完整的）。
 * 以前发过、这次没有了的规则段落列出来声明作废，免得模型还按旧规则做
 */
export function promptDelta(parts: string[], sent: PromptSent | undefined, session: string | undefined): string | null {
  if (!sent || !session || sent.session !== session || sent.turns >= FULL_EVERY) return null
  const sections = promptSections(parts)
  const keep: string[] = []
  const now = new Set<string>()
  let skipped = 0
  for (const s of sections) {
    now.add(s.key)
    if (always(s.key) || sent.hashes[s.key] !== hash53(s.text)) keep.push(s.text)
    else skipped++
  }
  const gone = Object.keys(sent.hashes).filter((k) => k && !now.has(k))
  // 什么都没省下（规则全变了）：直接发完整的，不加说明
  if (!skipped && !gone.length) return null
  if (gone.length)
    keep.push(
      `## 不再适用的规则\n之前给过的这些段落这次已经不适用，不要再按它们做：${gone.map((k) => `「${k.replace(/^## /, '').replace(/#\d+$/, '')}」`).join('、')}`,
    )
  if (skipped)
    keep.push(
      '（其余规则和之前在这个会话里给过的完全一样、仍然有效，这里不重复；上面列出的段落是新的或有变化的，以这一版为准。）',
    )
  return keep.join('\n\n')
}

/** 这一轮发出去之后要记下的状态：发了完整提示从 0 计，发了增量的在原来的轮数上加一 */
export function nextSent(parts: string[], session: string, delta: boolean, prev: PromptSent | undefined): PromptSent {
  return { session, hashes: sectionHashes(parts), turns: delta ? (prev?.turns ?? 0) + 1 : 0 }
}

/** 最多记这么多个会话：子任务一个一个会话，一直记下去任务文件会越攒越大；最久没用的先丢（丢了只是下次发完整的） */
export const MAX_SENT = 40

/** 记下一个会话收到过的段落，放到最后（最近用过）；超过 MAX_SENT 丢最早的 */
export function rememberSent(
  all: Record<string, PromptSent> | undefined,
  key: string,
  value: PromptSent,
): Record<string, PromptSent> {
  const { [key]: _old, ...rest } = all ?? {}
  const keys = Object.keys(rest)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SENT + 1))) delete rest[k]
  return { ...rest, [key]: value }
}
