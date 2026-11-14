// 输入框末尾的换行要有一个占位的 <br>。
// 输入框是 white-space: pre-wrap 的 contenteditable，换行是自己插的「\n」文字（见 RichInput 的 Shift+Enter）。
// 但块末尾的最后一个「\n」浏览器不画成新的一行：光标停在它后面时，Chrome 把输入位置规整到「\n」前面。
// 这时打字会落回上一行；用输入法打标点更糟：组合的字先插在「\n」前面，上屏时又在原位置插一遍，
// 一个标点出来两个，而且 compositionend 不来，之后的回车都被当成组合中的按键吞掉。
// 末尾补一个 <br data-tail>，「\n」后面就是真正的一行，光标、打字和输入法都落在新行上。
// 这个 <br> 只是占位，读回文字时不算（见 RichInput 的 serialize）。

/** 是不是末尾占位的 <br> */
export const isTailBreak = (node: Node | null | undefined): node is HTMLBRElement =>
  node instanceof HTMLBRElement && node.dataset.tail !== undefined

/** 末尾最后一个有内容的节点是不是以「\n」结尾的文字（空文字节点跳过） */
function endsWithBreak(root: HTMLElement): boolean {
  for (let n = root.lastChild; n; n = n.previousSibling) {
    if (isTailBreak(n)) continue
    if (n.nodeType !== Node.TEXT_NODE) return false
    const v = n.nodeValue ?? ''
    if (v === '') continue
    return v.endsWith('\n')
  }
  return false
}

/**
 * 按现在的内容补上或去掉末尾占位的 <br>。
 * 输入法组合中不动：组合中改 DOM 会打断输入法，多出来或缺了的 <br> 等组合结束再补（读回文字时它不算，不影响内容）
 */
export function syncTailBreak(root: HTMLElement, composing = false) {
  if (composing) return
  const need = endsWithBreak(root)
  // 占位的 <br> 只能在最后：输入法、粘贴把字插到它后面时，它就不在末尾了，末尾另补一个
  if (need && !isTailBreak(root.lastChild)) {
    const br = document.createElement('br')
    br.dataset.tail = ''
    root.append(br)
  }
  for (const n of Array.from(root.childNodes)) if (isTailBreak(n) && !(need && n === root.lastChild)) n.remove()
}
