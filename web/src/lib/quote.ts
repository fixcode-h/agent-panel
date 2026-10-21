import { useEffect } from 'react'

/**
 * 「引用」：消息下面的按钮把这段内容作为引用块放进输入框。
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

/** 引用块：每行前面加「> 」，后面空一行给用户接着写 */
export function quoteBlock(text: string) {
  const body = text
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
  return `${body}\n\n`
}

/** 对话接住引用：scope 是这个对话的根元素 */
export function useQuoteTarget(el: HTMLElement | null, onQuote: (block: string) => void) {
  useEffect(() => {
    if (!el) return
    const on = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      onQuote(quoteBlock(String((e as CustomEvent).detail ?? '')))
    }
    el.addEventListener(QUOTE_EVENT, on)
    return () => el.removeEventListener(QUOTE_EVENT, on)
  })
}
