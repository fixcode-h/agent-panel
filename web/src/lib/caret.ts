/**
 * 让光标停在输入框的可见区域里。
 *
 * 用户自己打字时光标由浏览器保证可见；但内容由程序插入或重写时（Shift+Enter 换行、Skill / 图片卡片、
 * 插入模板、草稿恢复后重画输入框、点选历史消息）浏览器不会跟着滚，光标停在可视区外，
 * 看起来就像输入框没跟上光标。
 */

/** 光标贴边时留的空隙，不然看起来像被裁掉了 */
const GAP = 4

/** 零宽字符：插在光标处量位置，量完拿掉，文字内容不变 */
const ZERO = '\u200b'

interface Caret {
  top: number
  height: number
  left?: number
  width?: number
}

/** textarea 的文字排版要一模一样，镜像量出来才对得上 */
const MIRRORED = [
  'direction',
  'text-align',
  'text-indent',
  'text-transform',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'tab-size',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
]

const lineHeight = (el: Element) => {
  const cs = getComputedStyle(el)
  return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
}

const borderOf = (el: Element) => {
  const cs = getComputedStyle(el)
  return {
    top: parseFloat(cs.borderTopWidth) || 0,
    left: parseFloat(cs.borderLeftWidth) || 0,
  }
}

/** 输入框边框内侧的坐标（和 scrollTop 同一套） */
const local = (el: HTMLElement, rect: DOMRect) => {
  const box = el.getBoundingClientRect()
  const border = borderOf(el)
  return {
    top: rect.top - box.top - border.top + el.scrollTop,
    left: rect.left - box.left - border.left + el.scrollLeft,
  }
}

/**
 * textarea / input 的光标位置：原生输入框量不到光标，拿一个同样排版的镜像，
 * 在光标处放个零宽标记量出来。
 */
function fieldCaret(el: HTMLTextAreaElement | HTMLInputElement): Caret | null {
  const cs = getComputedStyle(el)
  const mirror = document.createElement('div')
  const s = mirror.style
  s.position = 'fixed'
  s.top = '0'
  s.left = '-10000px'
  s.visibility = 'hidden'
  s.pointerEvents = 'none'
  s.boxSizing = 'border-box'
  s.width = `${el.clientWidth}px`
  s.whiteSpace = el instanceof HTMLInputElement ? 'pre' : 'pre-wrap'
  s.overflowWrap = 'break-word'
  s.wordBreak = cs.wordBreak
  s.overflow = 'hidden'
  for (const p of MIRRORED) s.setProperty(p, cs.getPropertyValue(p))
  mirror.textContent = el.value.slice(0, el.selectionStart ?? el.value.length)
  const marker = document.createElement('span')
  marker.textContent = ZERO
  mirror.append(marker)
  document.body.append(mirror)
  const at = marker.getBoundingClientRect()
  const root = mirror.getBoundingClientRect()
  mirror.remove()
  const border = borderOf(el)
  // 镜像没有滚动：位置相对镜像量出内容坐标（scrollTop 的零点在边框内侧）
  return {
    top: at.top - root.top - border.top,
    height: at.height || lineHeight(el),
    left: at.left - root.left - border.left,
    width: at.width,
  }
}

/**
 * contenteditable 的光标位置。折叠的光标在元素边界上（换行之后、卡片旁边、空行）量不到矩形，
 * 这时在光标处临时插一个零宽标记量一次，量完拿掉并把光标放回原处。
 */
function editableCaret(el: HTMLElement): Caret | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return null

  const direct = range.getBoundingClientRect()
  if (direct.height > 0) {
    const at = local(el, direct)
    return { top: at.top, height: direct.height, left: at.left, width: direct.width }
  }

  // 光标在行内卡片里面：按整张卡片算，别往卡片里插东西
  const holder =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  const chip = holder?.closest('[data-chip]')
  if (chip) {
    const at = local(el, chip.getBoundingClientRect())
    return { top: at.top, height: chip.getBoundingClientRect().height, left: at.left, width: 0 }
  }

  const marker = document.createElement('span')
  marker.textContent = ZERO
  const at = range.cloneRange()
  at.collapse(true)
  try {
    at.insertNode(marker)
  } catch {
    return null
  }
  const rect = marker.getBoundingClientRect()
  const after = document.createRange()
  after.setStartAfter(marker)
  after.collapse(true)
  marker.remove()
  if (document.activeElement === el) {
    sel.removeAllRanges()
    sel.addRange(after)
  }
  const spot = local(el, rect)
  return { top: spot.top, height: rect.height || lineHeight(el), left: spot.left, width: rect.width }
}

/** 让光标滚进输入框的可见区域；已经看得见就不动 */
export function scrollCaretIntoView(el: Element | null | undefined) {
  const node = el as HTMLElement | null
  if (!node || !node.isConnected) return
  if (node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1) return
  const caret = textField(node) ? fieldCaret(node) : node.isContentEditable ? editableCaret(node) : null
  if (!caret) return

  const top = node.scrollTop
  const bottom = top + node.clientHeight
  if (caret.top - GAP < top) node.scrollTop = Math.max(0, caret.top - GAP)
  else if (caret.top + caret.height + GAP > bottom) node.scrollTop = caret.top + caret.height + GAP - node.clientHeight

  // 单行输入框是横向滚动的
  if (caret.left !== undefined && caret.width !== undefined && node.scrollWidth > node.clientWidth + 1) {
    const from = node.scrollLeft
    const to = from + node.clientWidth
    if (caret.left - GAP < from) node.scrollLeft = Math.max(0, caret.left - GAP)
    else if (caret.left + caret.width + GAP > to) node.scrollLeft = caret.left + caret.width + GAP - node.clientWidth
  }
}

/** 光标和滚动位置的快照：测量会动一下 DOM，用它避免自己触发自己 */
function snapshot(el: HTMLElement): string {
  // 原生输入框的光标在 window.getSelection() 里看不到，用 selectionStart 记
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
    return `${el.selectionStart}:${el.selectionEnd}:${el.scrollTop}:${el.scrollHeight}:${el.value.length}`
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return ''
  const r = sel.getRangeAt(0)
  return `${idOf(r.startContainer)}:${r.startOffset}:${el.scrollTop}:${el.scrollHeight}`
}

let seq = 0
const ids = new WeakMap<Node, number>()
function idOf(node: Node): number {
  let n = ids.get(node)
  if (n === undefined) {
    n = ++seq
    ids.set(node, n)
  }
  return n
}

/** 能读光标位置的原生输入框（number、checkbox 等的 selectionStart 是 null） */
const textField = (el: Element | null): el is HTMLTextAreaElement | HTMLInputElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.selectionStart !== null)

const editing = (el: Element | null): el is HTMLElement =>
  !!el && (textField(el) || (el instanceof HTMLElement && el.isContentEditable))

/** 有滚动条的输入框才需要管 */
const scrollable = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1

/**
 * 统一兜底：光标一动（打字、方向键、点选、程序设置选区）就看一眼它在不在可视区里。
 * 浏览器自己会滚的照常，这里只补它没管的那些情况。
 */
export function installCaretAutoScroll(): () => void {
  let frame = 0
  const last = new WeakMap<HTMLElement, string>()

  const check = (target?: EventTarget | null) => {
    const active = document.activeElement
    const el =
      target instanceof Element && target instanceof HTMLElement && target.isContentEditable
        ? target
        : editing(active)
          ? active
          : null
    if (!el || !scrollable(el)) return
    cancelAnimationFrame(frame)
    // 等默认行为和布局都落定再量
    frame = requestAnimationFrame(() => {
      if (!el.isConnected) return
      const key = snapshot(el)
      if (last.get(el) === key) return
      last.set(el, key)
      scrollCaretIntoView(el)
      last.set(el, snapshot(el))
    })
  }

  const onSelection = () => check()
  const onInput = (e: Event) => check(e.target)
  // 方向键、Home/End：光标位置变了，和输入一样要跟
  const onKey = () => check()
  const onFocus = (e: Event) => check(e.target)

  document.addEventListener('selectionchange', onSelection)
  document.addEventListener('input', onInput, true)
  document.addEventListener('keyup', onKey, true)
  document.addEventListener('focusin', onFocus, true)
  document.addEventListener('compositionend', onInput, true)
  return () => {
    cancelAnimationFrame(frame)
    document.removeEventListener('selectionchange', onSelection)
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('keyup', onKey, true)
    document.removeEventListener('focusin', onFocus, true)
    document.removeEventListener('compositionend', onInput, true)
  }
}
