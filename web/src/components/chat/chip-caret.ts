// 输入框里的光标不能停在卡片里面。
// 卡片是 contenteditable="false" 的行内元素，正常点击、方向键都进不去；但 Chrome 里在卡片紧后面用输入法打了拼音、
// 再按退格把拼音清掉时，组合结束后浏览器会把光标落在卡片内部（卡片文字的末尾）。光标在里面时：
// 退格认不出旁边的卡片、浏览器原生删除也删不动（卡片删不掉），接着输入法上屏的字直接丢掉，
// 再粘贴图片或文字就插进了卡片里面——卡片外壳还在，里面挤进别的内容，文件名被挤成零宽看不见了。
// 这里在光标掉进去时把它挪回卡片外面，插入内容前也先挪一次。

/** node 所在的卡片：取最外层那张（万一已经套了卡片也整张算），不在卡片里时是 null */
export function chipAround(root: HTMLElement, node: Node | null): HTMLElement | null {
  if (!node || node === root || !root.contains(node)) return null
  let el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
    '[data-chip]',
  )
  if (!el || !root.contains(el)) return null
  for (let up = el.parentElement?.closest<HTMLElement>('[data-chip]'); up && root.contains(up);) {
    el = up
    up = el.parentElement?.closest<HTMLElement>('[data-chip]')
  }
  return el
}

/**
 * 光标或选区的端点落进卡片里时挪到卡片外：光标挪到卡片紧后面（就是用户原来停的位置，按一次退格整张删掉），
 * 选区的起点挪到卡片前、终点挪到卡片后（选中的部分卡片当整张）。挪过返回 true
 */
export function caretOutOfChip(root: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return false
  const r = sel.getRangeAt(0)
  const start = chipAround(root, r.startContainer)
  const end = chipAround(root, r.endContainer)
  if (!start && !end) return false
  const next = document.createRange()
  if (r.collapsed) {
    next.setStartAfter(start!)
    next.collapse(true)
  } else {
    if (start) next.setStartBefore(start)
    else next.setStart(r.startContainer, r.startOffset)
    if (end) next.setEndAfter(end)
    else next.setEnd(r.endContainer, r.endOffset)
  }
  sel.removeAllRanges()
  sel.addRange(next)
  return true
}
