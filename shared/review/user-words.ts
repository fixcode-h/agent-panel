/**
 * 派评审时面板自动附上「用户在这个对话里说过的要求」（分析稿 B2）：用户亲口说的话，加上父对话经 quote 原样转过来的原话。
 *
 * 为什么：弱模型常把用户的说法「并进」自己的方案（「这正是方案 A 的方向」），实际上没照做；
 * 评审只对照派单和交接单，交接单附不附用户原话是 Agent 自己写的，看不到用户在执行中说过什么。
 * 面板按消息记录取原话交给评审，评审对照「用户点名的做法有没有采用、没采用有没有写理由」，不新加门禁，走现有的处置流程。
 * 只取消息记录里的事实，不读、不判断回复文字（ADR 0041、0049）。交给 Agent 的话是提示词，不翻译
 */
import type { Task, TaskMessage } from '../schema.ts'

/** 附给评审的上限：太长评审读不完，留最近的（最近的话最能代表用户现在要什么） */
const MAX_CHARS = 1500
/** 一句话最多取这么多：贴了大段日志的不整段带过去 */
const MAX_ONE = 400

export interface UserWord {
  id: string
  at: string
  text: string
  /** 父对话转过来的原话 */
  quoted?: boolean
}

/** 用户亲口说的（不是别的对话转来的、不是面板推的） */
const ownWords = (m: TaskMessage) => m.role === 'user' && !m.peer && !m.panel && !!m.text.trim()

/** 这个对话里用户说过的话（含转过来的原话），按时间排，同一条只算一次 */
export function userWordsOf(task: Pick<Task, 'messages'>): UserWord[] {
  const seen = new Set<string>()
  const out: UserWord[] = []
  for (const m of task.messages) {
    if (ownWords(m) && !seen.has(m.id)) {
      seen.add(m.id)
      out.push({ id: m.id, at: m.at, text: m.text.trim() })
    }
    for (const q of m.peer?.said ?? [])
      if (!seen.has(q.id) && q.text.trim()) {
        seen.add(q.id)
        out.push({ id: q.id, at: q.at, text: q.text.trim(), quoted: true })
      }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** 写进评审提示词的一节；用户在这个对话里什么都没说过（只有父对话的派单）时返回空 */
export function userWordsPart(task: Pick<Task, 'messages'>, max = MAX_CHARS): string {
  const all = userWordsOf(task)
  if (!all.length) return ''
  const picked: string[] = []
  let used = 0
  for (const w of [...all].reverse()) {
    const one = w.text.length > MAX_ONE ? `${w.text.slice(0, MAX_ONE)}…` : w.text
    const line = `> ${w.quoted ? '（父对话转来的原话）' : ''}${one.replace(/\n/g, '\n> ')}`
    if (picked.length && used + line.length > max) break
    picked.unshift(line)
    used += line.length
  }
  const cut = picked.length < all.length ? `\n（更早的 ${all.length - picked.length} 条没附上）` : ''
  return `## 用户在这个对话里说过的话（面板按原文附上，按时间排）
对照差异核对：用户点名的做法（函数、文件、方向、要不要做某件事）有没有采用。没采用、交接单里也没写理由的，按 🟠 中级列一条「没照用户说的做」，写清用户说的是哪句、改动实际怎么做的；用户只是提问或闲聊的不算。

${picked.join('\n\n')}${cut}`
}
