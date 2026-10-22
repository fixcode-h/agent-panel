import { useEffect } from 'react'
import { segments, chipMarker, quoteBlock, type Chip } from '@shared/composer'

/**
 * 「引用」：消息下面的按钮把这段内容作为一张引用卡片放进输入框（和附件卡片一样，右上角能删）。
 * 引用卡片背后是一个带原文的附件（Attachment.quote，见 Attachments.tsx 的 addQuote），发出去后对话里还是这张卡片。
 * 按钮从自己的位置往上冒一个事件，离它最近的对话（子对话在父对话的右栏里时就是子对话）接住，
 * 所以同一页上有几个输入框时也不会放错地方
 */
const QUOTE_EVENT = 'agent-panel:quote'

/** 从按钮发出引用；没有对话接住时返回 false */
export function quoteFrom(el: HTMLElement, text: string) {
  const ev = new CustomEvent(QUOTE_EVENT, { bubbles: true, cancelable: true, detail: text })
  el.dispatchEvent(ev)
  return ev.defaultPrevented
}

export { quoteBlock }

// 以前的引用卡片只有标记，原文存在本地：留着读取，旧草稿里的卡片还能发出原文
const STORE = 'chat-quotes'
/** 没发出去的引用最多留这么久，免得本地越攒越多 */
const KEEP_MS = 14 * 24 * 3600 * 1000
type Stored = Record<string, { text: string; at: number }>
const memory: Stored = {}

function readStore(): Stored {
  try {
    const raw = localStorage.getItem(STORE)
    const v = raw ? (JSON.parse(raw) as Stored) : {}
    return v && typeof v === 'object' ? { ...v, ...memory } : { ...memory }
  } catch {
    return { ...memory }
  }
}

function saveQuote(id: string, text: string) {
  memory[id] = { text, at: Date.now() }
  try {
    const now = Date.now()
    const all = readStore()
    for (const [k, v] of Object.entries(all)) if (!v?.at || now - v.at > KEEP_MS) delete all[k]
    localStorage.setItem(STORE, JSON.stringify(all))
  } catch {}
}

/** 卡片名字是「摘要#编号」：摘要给人看，编号找原文 */
const ID_RE = /#(q[0-9a-z]+)$/

export const quoteId = (name: string) => ID_RE.exec(name)?.[1] ?? ''
/** 卡片上显示的摘要 */
export const quoteLabel = (name: string) => name.replace(ID_RE, '')
/** 引用的原文（找不到时是空的） */
export const quoteText = (name: string) => {
  const id = quoteId(name)
  return id ? (readStore()[id]?.text ?? '') : ''
}

/**
 * 新引用卡片的名字「摘要#编号」：标记里不能有方括号和换行；摘要取开头一小段，太长的卡片会把输入框撑乱。
 * 服务端认回粘贴的引用文件时按同样的规则起名（server/uploads.ts）
 */
export function quoteName(text: string) {
  const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const flat = text.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  const label = flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
  return { id, name: `${label}#${id}` }
}

/** 只存在本地的引用卡片（附件上传不了时退回用它） */
export function quoteChip(text: string): Chip {
  const { id, name } = quoteName(text)
  saveQuote(id, text)
  return { kind: 'quote', name }
}

/**
 * 发送前处理只存在本地的引用卡片：换回引用块；原文丢了（例如清过浏览器数据）就用卡片上的摘要。
 * 有对应附件的引用卡片（现在的做法）原样留着，发出去后对话里还是卡片
 */
export function expandQuotes(value: string, attachments: readonly { name: string; quote?: string }[] = []) {
  let out = ''
  for (const s of segments(value)) {
    if ('text' in s) out += s.text
    else if (s.chip.kind !== 'quote' || attachments.some((a) => a.quote !== undefined && a.name === s.chip.name))
      out += chipMarker(s.chip.kind, s.chip.name)
    else out += `\n${quoteBlock(quoteText(s.chip.name) || quoteLabel(s.chip.name))}`
  }
  return out.replace(/^\n+/, '')
}

/** 对话接住引用：scope 是这个对话的根元素，拿到的是被引用的原文 */
export function useQuoteTarget(el: HTMLElement | null, onQuote: (text: string) => void) {
  useEffect(() => {
    if (!el) return
    const on = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      onQuote(String((e as CustomEvent).detail ?? ''))
    }
    el.addEventListener(QUOTE_EVENT, on)
    return () => el.removeEventListener(QUOTE_EVENT, on)
  })
}
