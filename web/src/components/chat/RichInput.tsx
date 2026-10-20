// 输入框本体：能放文字，也能放行内卡片（Skill、命令、图片、文件）。
// 卡片是 contenteditable="false" 的元素，光标停在它旁边按一次退格就整张删掉；
// 文字里的表示见 shared/composer.ts 的标记。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { chipMarker, removeChip, segments, type Chip, type ChipKind } from '@shared/composer'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

export interface RichInputHandle {
  /** 现在的内容（带标记的文字） */
  text(): string
  /** 光标在文字里的位置（按带标记的文字算；不在输入框里时是末尾） */
  caret(): number
  setCaret(pos: number): void
  /** 光标处插入文字，替换选中的内容 */
  insert(text: string): void
  /** 光标处插入一张卡片 */
  insertChip(chip: Chip): void
  /** 替换一段（命令菜单、@ 引用用）：位置按带标记的文字算 */
  replace(from: number, to: number, text: string): void
  focus(): void
  element(): HTMLElement | null
}

/** 图片卡片要显示缩略图：按附件名字取本地预览地址 */
type Preview = (name: string) => string | undefined

const isCommand = (kind: ChipKind) => kind === 'skill' || kind === 'command'

/** 把一段 DOM 读回带标记的文字 */
function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').replace(/\u00a0/g, ' ')
  if (node instanceof HTMLElement) {
    const kind = node.dataset.chip as ChipKind | undefined
    if (kind) return chipMarker(kind, node.dataset.name ?? '')
    if (node.tagName === 'BR') return '\n'
  }
  let out = ''
  node.childNodes.forEach((c) => (out += serialize(c)))
  return out
}

/** 一张卡片在输入框里的样子 */
function chipNode(chip: Chip, preview?: Preview): HTMLElement {
  const el = document.createElement('span')
  el.contentEditable = 'false'
  el.dataset.chip = chip.kind
  el.dataset.name = chip.name
  el.title = t('按退格键删除')
  el.className = cn(
    'mx-0.5 inline-flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-md border px-1.5 align-middle text-[0.8125rem] leading-[1.7]',
    isCommand(chip.kind) ? 'border-accent/35 bg-accent-soft text-accent' : 'border-line-strong bg-field/70 text-fg',
  )
  const src = chip.kind === 'image' ? preview?.(chip.name) : undefined
  if (src) {
    const img = document.createElement('img')
    img.src = src
    img.alt = ''
    img.className = 'h-4 w-4 shrink-0 rounded object-cover'
    el.append(img)
  }
  const label = document.createElement('span')
  label.className = cn('truncate', isCommand(chip.kind) && 'font-mono')
  label.textContent = isCommand(chip.kind) ? `/${chip.name}` : chip.name
  el.append(label)
  return el
}

/** 一段带标记的文字对应的 DOM 节点：标记变成真卡片 */
function nodesOf(value: string, preview?: Preview): Node[] {
  return segments(value).map((s) => ('text' in s ? document.createTextNode(s.text) : chipNode(s.chip, preview)))
}

/** 按文字重新画一遍输入框 */
function paint(root: HTMLElement, value: string, preview?: Preview) {
  root.replaceChildren(...nodesOf(value, preview))
}

/** 一张卡片在文字里的起点 */
function offsetOf(root: HTMLElement, target: Node): number {
  let at = 0
  for (const n of Array.from(root.childNodes)) {
    if (n === target) return at
    at += serialize(n).length
  }
  return at
}

/** 第 pos 个字在 DOM 里的位置 */
function locate(root: HTMLElement, pos: number): { node: Node; offset: number } {
  let left = Math.max(pos, 0)
  const step = (parent: Node): { node: Node; offset: number } | null => {
    const kids = Array.from(parent.childNodes)
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i]
      if (kid.nodeType === Node.TEXT_NODE) {
        const len = (kid.nodeValue ?? '').length
        if (left <= len) return { node: kid, offset: left }
        left -= len
        continue
      }
      const len = serialize(kid).length
      if (left < len) return { node: parent, offset: i }
      if (left === len) return { node: parent, offset: i + 1 }
      left -= len
    }
    return null
  }
  return step(root) ?? { node: root, offset: root.childNodes.length }
}

export function RichInput({
  value,
  onChange,
  onSync,
  onKeyDown,
  onPaste,
  handle,
  id,
  label,
  placeholder,
  disabled,
  autoFocus,
  pad,
  className,
  preview,
}: {
  value: string
  onChange: (v: string) => void
  /** 文字或光标变了（「/」「@」列表跟着更新） */
  onSync?: () => void
  /** 先交给「/」「@」列表处理按键；返回 true 表示处理掉了 */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => boolean
  /** 粘贴：有文件时由外面接过去（接着会 preventDefault） */
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void
  handle?: React.RefObject<RichInputHandle | null>
  id?: string
  label: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  /** 内边距：输入的文字和占位提示要一模一样 */
  pad?: string
  className?: string
  preview?: Preview
}) {
  const el = useRef<HTMLDivElement>(null)
  // 最后一次画进 DOM 的内容：自己输入引起的变化不再画一遍，否则光标会跳。
  // 预览地址也要记：图片缩略图是上传完才有的，那时文字没变也得重画一次。
  const painted = useRef<{ value: string; preview?: Preview } | null>(null)
  const cb = useRef({ onChange, onSync, onKeyDown, onPaste, preview })
  cb.current = { onChange, onSync, onKeyDown, onPaste, preview }

  const emit = useCallback(() => {
    const node = el.current
    if (!node) return
    const next = serialize(node)
    painted.current = { value: next, preview: cb.current.preview }
    cb.current.onChange(next)
    cb.current.onSync?.()
  }, [])

  const place = useCallback((pos: number) => {
    const node = el.current
    if (!node) return
    const at = locate(node, pos)
    const sel = window.getSelection()
    if (!sel) return
    const r = document.createRange()
    r.setStart(at.node, at.offset)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }, [])

  const caretNow = useCallback(() => {
    const node = el.current
    if (!node) return 0
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return serialize(node).length
    const r = sel.getRangeAt(0)
    if (!node.contains(r.startContainer)) return serialize(node).length
    const pre = document.createRange()
    pre.selectNodeContents(node)
    pre.setEnd(r.startContainer, r.startOffset)
    return serialize(pre.cloneContents()).length
  }, [])

  const api = useMemo<RichInputHandle>(() => {
    /** 光标处的 range：不在输入框里（点了按钮）时放到末尾 */
    const rangeNow = () => {
      const node = el.current!
      const sel = window.getSelection()
      if (sel && sel.rangeCount && node.contains(sel.anchorNode)) return sel.getRangeAt(0)
      const r = document.createRange()
      r.selectNodeContents(node)
      r.collapse(false)
      return r
    }
    const put = (nodes: Node[]) => {
      const node = el.current
      if (!node) return
      const r = rangeNow()
      r.deleteContents()
      const frag = document.createDocumentFragment()
      nodes.forEach((n) => frag.append(n))
      const last = frag.lastChild
      r.insertNode(frag)
      const sel = window.getSelection()
      if (sel && last) {
        const after = document.createRange()
        after.setStartAfter(last)
        after.collapse(true)
        sel.removeAllRanges()
        sel.addRange(after)
      }
      emit()
    }
    return {
      text: () => serialize(el.current ?? document.createElement('div')),
      caret: () => caretNow(),
      setCaret: (pos) => place(pos),
      insert: (text) => put(nodesOf(text, cb.current.preview)),
      insertChip: (chip) => {
        const node = el.current
        if (!node) return
        const r = rangeNow()
        const before = r.cloneRange()
        before.selectNodeContents(node)
        before.setEnd(r.startContainer, r.startOffset)
        const after = r.cloneRange()
        after.selectNodeContents(node)
        after.setStart(r.endContainer, r.endOffset)
        const left = serialize(before.cloneContents())
        const right = serialize(after.cloneContents())
        const chipEl = chipNode(chip, cb.current.preview)
        const nodes: Node[] = []
        if (left && !/\s$/.test(left)) nodes.push(document.createTextNode(' '))
        nodes.push(chipEl)
        // 后面紧跟文字时补一个空格；在末尾也补上，接着往下写不用自己敲
        if (!right || !/^\s/.test(right)) nodes.push(document.createTextNode(' '))
        r.deleteContents()
        const frag = document.createDocumentFragment()
        nodes.forEach((n) => frag.append(n))
        r.insertNode(frag)
        // 光标停在卡片紧后面（补的空格之前），按一次退格就整张删掉
        const sel = window.getSelection()
        if (sel) {
          const at = document.createRange()
          at.setStartAfter(chipEl)
          at.collapse(true)
          sel.removeAllRanges()
          sel.addRange(at)
        }
        emit()
      },
      replace: (from, to, text) => {
        const node = el.current
        if (!node) return
        const start = locate(node, from)
        const end = locate(node, to)
        const r = document.createRange()
        r.setStart(start.node, start.offset)
        r.setEnd(end.node, end.offset)
        r.deleteContents()
        if (text) {
          const frag = document.createDocumentFragment()
          nodesOf(text, cb.current.preview).forEach((n) => frag.append(n))
          const last = frag.lastChild
          r.insertNode(frag)
          const sel = window.getSelection()
          if (sel && last) {
            const after = document.createRange()
            after.setStartAfter(last)
            after.collapse(true)
            sel.removeAllRanges()
            sel.addRange(after)
          }
        }
        emit()
      },
      focus: () => el.current?.focus(),
      element: () => el.current,
    }
  }, [caretNow, emit, place])

  /** 删掉一张卡片：旁边多出来的空格也一起收掉 */
  const dropAtChip = useCallback(
    (chipEl: HTMLElement) => {
      const node = el.current
      if (!node) return
      const at = offsetOf(node, chipEl)
      const next = removeChip(serialize(node), {
        kind: chipEl.dataset.chip as ChipKind,
        name: chipEl.dataset.name ?? '',
      })
      paint(node, next, cb.current.preview)
      painted.current = { value: next, preview: cb.current.preview }
      cb.current.onChange(next)
      cb.current.onSync?.()
      place(at)
    },
    [place],
  )

  /**
   * 光标紧挨着的卡片（退格看前面、Delete 看后面）。
   * 卡片后面会自动补一个空格，光标停在空格后面时也算紧挨着，按一次退格整张删掉。
   */
  const chipBeside = useCallback((dir: -1 | 1) => {
    const node = el.current
    const sel = window.getSelection()
    if (!node || !sel || !sel.rangeCount || !sel.isCollapsed) return null
    const r = sel.getRangeAt(0)
    if (!node.contains(r.startContainer)) return null

    let parent: Node = r.startContainer
    let start: number
    if (r.startContainer.nodeType === Node.TEXT_NODE) {
      const text = r.startContainer.nodeValue ?? ''
      const textIndex = Array.prototype.indexOf.call(r.startContainer.parentNode!.childNodes, r.startContainer)
      if (r.startOffset !== 0 && r.startOffset !== text.length) return null
      if (dir < 0) {
        // 光标在文字的末尾：只有卡片后补的那个空格可以跳过，有字先删字
        if (r.startOffset === text.length && text !== ' ') return null
        start = r.startOffset === 0 ? textIndex - 1 : textIndex
      } else {
        if (r.startOffset === 0 && text !== ' ') return null
        start = r.startOffset === text.length ? textIndex + 1 : textIndex
      }
      parent = r.startContainer.parentNode!
    } else {
      start = dir < 0 ? r.startOffset - 1 : r.startOffset
    }

    // 往前/往后看：跳过空文本和卡片后面补的一个空格，碰到别的内容就停
    const kids = parent.childNodes
    let space = false
    for (let i = start; i >= 0 && i < kids.length; i += dir) {
      const n = kids[i]
      if (n instanceof HTMLElement && n.dataset.chip) return n
      if (n.nodeType !== Node.TEXT_NODE) return null
      const v = n.nodeValue ?? ''
      if (v === '') continue
      if (!space && v === ' ') {
        space = true
        continue
      }
      return null
    }
    return null
  }, [])

  useLayoutEffect(() => {
    if (handle) handle.current = api
  }, [handle, api])

  // 内容或预览变了就重画：自己输入引起的那次已经和 DOM 一致，跳过（光标不跳）
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    if (painted.current?.value === value && painted.current?.preview === preview) return
    const focused = document.activeElement === node
    const at = focused ? caretNow() : -1
    paint(node, value, preview)
    painted.current = { value, preview }
    if (at >= 0) place(Math.min(at, serialize(node).length))
  }, [value, preview, caretNow, place])

  // 光标动了（点、选、方向键）也要让「/」「@」列表跟着变
  useEffect(() => {
    const onSel = () => {
      if (el.current && document.activeElement === el.current) cb.current.onSync?.()
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  useEffect(() => {
    if (autoFocus && !disabled) el.current?.focus()
    // 只在打开时
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative">
      <div
        id={id}
        ref={el}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-placeholder={placeholder}
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={cn(
          'block w-full overflow-y-auto bg-transparent break-words whitespace-pre-wrap outline-none focus-visible:outline-none',
          disabled && 'cursor-not-allowed opacity-60',
          pad,
          className,
        )}
        onInput={emit}
        onKeyDown={(e) => {
          if (cb.current.onKeyDown?.(e)) return
          if (e.defaultPrevented || e.nativeEvent.isComposing) return
          if (e.key === 'Backspace' || e.key === 'Delete') {
            const chip = chipBeside(e.key === 'Backspace' ? -1 : 1)
            if (!chip) return
            e.preventDefault()
            dropAtChip(chip)
            return
          }
          // 换行自己插：浏览器插出来的 <div>、<br> 读回来不好还原
          if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            api.insert('\n')
          }
        }}
        onPaste={(e) => {
          cb.current.onPaste?.(e)
          if (e.defaultPrevented) return
          // 只接纯文本，别把网页上的样式带进来
          e.preventDefault()
          api.insert(e.clipboardData.getData('text/plain'))
        }}
      />
      {!value && placeholder && (
        <span className={cn('pointer-events-none absolute inset-0 overflow-hidden text-subtle', pad)}>
          {placeholder}
        </span>
      )}
    </div>
  )
}
