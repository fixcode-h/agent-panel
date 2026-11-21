/**
 * 父对话转述用户的话（send_to_conversation 的 quote）：按消息 id 从父对话里取用户原话，原样带给子对话。
 *
 * 为什么：用户 2026-11-21 报，在父对话里说的修法转到子对话后只剩父对话的转述，子对话的诊断报告不认它是用户说的
 * （chatSaid 跳过别的对话转来的消息），没法按用户原话出新一版；父对话还可能改写或漏掉关键的函数名。
 * 面板只核对 id 确实是用户在父对话里亲口发的消息，不读文字（ADR 0041、0049）。交给 Agent 的话是提示词，不翻译
 */
import type { PeerFrom, TaskMessage } from '../schema.ts'

export type UserQuote = NonNullable<PeerFrom['said']>[number]

/** 一次最多带这么多句：再多一般是把整段对话都转过去了 */
const MAX_QUOTES = 8
const MAX_TEXT = 2000

/** 用户在这个对话里亲口发的（不是别的对话转来的、不是面板推的） */
const ownWords = (m: TaskMessage) => m.role === 'user' && !m.peer && !m.panel && !!m.text.trim()

/**
 * 按 id 取用户亲口说的话；"last" 表示用户在这个对话里最近的一条（新开一轮时模型看不到消息 id）。
 * 有对不上的返回 error（交给 Agent 的话）
 */
export function quotesOf(messages: TaskMessage[], ids: string[]): { said: UserQuote[] } | { error: string } {
  const last = [...messages].reverse().find(ownWords)?.id ?? ''
  const want = [...new Set(ids.map((x) => (x.trim() === 'last' ? last : x.trim())).filter(Boolean))]
  if (!want.length && ids.length) return { error: 'quote 写了 "last"，但这个对话里还没有用户发的消息。' }
  if (want.length > MAX_QUOTES) return { error: `quote 最多写 ${MAX_QUOTES} 条用户消息 id，只挑和这件事有关的那几条。` }
  const said: UserQuote[] = []
  const bad: string[] = []
  for (const id of want) {
    const m = messages.find((x) => x.id === id)
    if (!m || !ownWords(m)) bad.push(id)
    else said.push({ id: m.id, at: m.at, text: m.text.trim().slice(0, MAX_TEXT) })
  }
  if (bad.length)
    return {
      error: `quote 里的 ${bad.join('、')} 不是用户在这个对话里发的消息：只写用户亲口说的那几条消息的 id（插话说明里给了 id；是用户最近那一条就写 "last"），子对话、面板发来的不算。`,
    }
  return { said }
}

/** 交给子对话的正文后面附上原话：子对话看得到用户的原文，不只是父对话的转述 */
export function withQuotes(message: string, said: UserQuote[]): string {
  if (!said.length) return message
  const lines = said.map((q) => `> ${q.text.replace(/\n/g, '\n> ')}`).join('\n\n')
  return `${message}\n\n用户在父对话里的原话（面板按消息原样附上）：\n${lines}`
}
