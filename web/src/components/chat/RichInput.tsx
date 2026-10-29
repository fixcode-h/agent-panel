// 输入框本体：能放文字，也能放行内卡片（Skill、命令、图片、文件、引用）。
// 卡片是 contenteditable="false" 的元素，光标停在它旁边按一次退格就整张删掉；
// 文字里的表示见 shared/composer.ts 的标记。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { chipMarker, isAttachChip, removeChip, segments, type Chip, type ChipKind } from '@shared/composer'
import { setClipboardText } from '@/lib/clipboard-text'
import { cn } from '@/lib/utils'
import { CHIP_SHAPE, CHIP_TONE } from '@/components/ui/chip-tone'
import { scrollCaretIntoView } from '@/lib/caret'
import { quoteLabel, quoteText } from '@/lib/quote'
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
  /** 整个换成另一段文字（撤回、引用到输入框、外面替输入框清空时用） */
  setText(text: string): void
  /** 替换一段（命令菜单、@ 引用用）：位置按带标记的文字算 */
  replace(from: number, to: number, text: string): void
  focus(): void
  element(): HTMLElement | null
}

/** 图片卡片要显示缩略图：按附件名字取本地预览地址 */
type Preview = (name: string) => string | undefined

/** 附件卡片上显示的内容：@路径、大小和状态（见 shared/attachment-view.ts 的 chipTextOf） */
export interface ChipInfo {
  label: string
  /** 卡片末尾的状态（拷贝中、上传中…）；空表示已经就绪 */
  status?: string
  /** 鼠标停上去的提示；不写时用默认的「点击查看，按退格键删除」 */
  title?: string
}
type Info = (chip: Chip) => ChipInfo | undefined

/** 卡片上的操作：点卡片打开查看（图片看大图、文件看内容、引用看原文）、点右上角删除、右键弹菜单 */
export interface ChipActions {
  open?: (chip: Chip) => void
  remove?: (name: string) => void
  /** 右键卡片：位置是鼠标坐标，菜单自己在那个位置弹出来 */
  context?: (chip: Chip, at: { x: number; y: number }) => void
}

const isCommand = (kind: ChipKind) => kind === 'skill' || kind === 'command'

/**
 * 各类卡片的样子：图标（lucide 的路径）、文字前缀和配色。加新的卡片类型时在 composer.ts 加标记、在这里加一行，
 * 删除按钮、看大图这些交互所有卡片通用
 */
const CHIP_STYLE: Record<ChipKind, { icon: string; prefix?: string }> = {
  image: {
    icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  },
  file: {
    icon: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  },
  skill: {
    icon: '<path d="M9.94 14.06 4 20"/><path d="m14 4 6 6"/><path d="M12 2v2M19 12h2M5 5l1.5 1.5"/><path d="m14 4-4 4 6 6 4-4Z"/>',
    prefix: '/',
  },
  command: {
    icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 17 6-10"/>',
    prefix: '/',
  },
  // 引用对话里的一段：lucide 的 text-quote
  quote: {
    icon: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  },
}

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-[1.05em] w-[1.05em] shrink-0">${paths}</svg>`

/** 把一段 DOM 读回带标记的文字。chipText：卡片换成这个文字（复制到剪贴板用），不传就是卡片标记 */
function serialize(node: Node, chipText?: (chip: Chip) => string | undefined): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').replace(/\u00a0/g, ' ')
  if (node instanceof HTMLElement) {
    const kind = node.dataset.chip as ChipKind | undefined
    if (kind) {
      const chip = { kind, name: node.dataset.name ?? '' }
      return chipText?.(chip) ?? chipMarker(kind, chip.name)
    }
    if (node.tagName === 'BR') return '\n'
  }
  let out = ''
  node.childNodes.forEach((c) => (out += serialize(c, chipText)))
  return out
}

/** 卡片上的操作按钮（删除） */
function closeNode(onClick: () => void): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.contentEditable = 'false'
  btn.dataset.chipAction = 'remove'
  btn.title = t('移除')
  btn.setAttribute('aria-label', t('移除'))
  btn.className =
    'absolute -top-1.5 -right-1.5 grid h-4 w-4 cursor-pointer place-items-center rounded-full border bg-card text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sel hover:text-fg'
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="h-2.5 w-2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

/** 一张卡片在输入框里的样子 */
function chipNode(chip: Chip, preview?: Preview, actions?: () => ChipActions | undefined, info?: Info): HTMLElement {
  const el = document.createElement('span')
  el.contentEditable = 'false'
  el.dataset.chip = chip.kind
  el.dataset.name = chip.name
  // 图片卡片：缩略图和文件名排在一行，和文字卡片一样高；删除按钮叠在右上角，位置靠外层定位
  const style = CHIP_STYLE[chip.kind]
  const attach = isAttachChip(chip.kind)
  const shown = info?.(chip)
  // 样子和消息里的卡片一样（AttachmentView.tsx 的 MessageChip 也用 CHIP_TONE），发出去前后看起来是同一张
  const tone = CHIP_TONE[chip.kind]
  el.className = cn(
    CHIP_SHAPE,
    'group relative',
    tone.box,
    attach && cn('cursor-pointer transition-colors', tone.hover),
  )
  const src = chip.kind === 'image' ? preview?.(chip.name) : undefined
  // 引用卡片只显示开头一小段，鼠标停上去看完整原文
  el.title =
    shown?.title ??
    (chip.kind === 'quote'
      ? quoteText(chip.name) || t('点击查看，按退格键删除')
      : attach
        ? t('点击查看，按退格键删除')
        : t('按退格键删除'))
  if (attach) {
    // 点卡片打开查看；按下时不把光标挪进卡片
    el.addEventListener('mousedown', (e) => e.preventDefault())
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-chip-action]')) return
      e.preventDefault()
      actions?.()?.open?.(chip)
    })
    // 右键弹卡片菜单（复制）：不用浏览器原生菜单；右键不会触发 click，单击查看不受影响
    el.addEventListener('contextmenu', (e) => {
      const act = actions?.()
      if (!act?.context) return
      e.preventDefault()
      act.context(chip, { x: e.clientX, y: e.clientY })
    })
  }
  if (!src) {
    // 没有缩略图的卡片前面放类型图标：文件、技能、命令一眼能分开
    const icon = document.createElement('span')
    icon.className = cn('inline-flex shrink-0', tone.icon)
    icon.innerHTML = svg(style.icon)
    el.append(icon)
  }
  if (src) {
    // 图片：一行高的小缩略图，后面接文件名；点卡片看大图，鼠标停在卡片上时可点右上角删除
    const img = document.createElement('img')
    img.src = src
    img.alt = ''
    img.className = 'h-[1.25em] w-[1.25em] shrink-0 rounded-sm object-cover'
    el.append(img)
  }
  // 文字节点始终叫 data-chip-main：卡片刚插进来时 items 还没渲染，info 拿不到，
  // 先放文件名占位，随后 updateChipInfo 改成 @路径 + 大小（不改的话第一次插入永远只有文件名）
  const main = document.createElement('span')
  main.dataset.chipMain = ''
  if (shown) {
    main.className = 'min-w-0 truncate'
    main.textContent = shown.label
  } else {
    main.className = cn('truncate', isCommand(chip.kind) && 'font-mono')
    main.textContent = `${style.prefix ?? ''}${chip.kind === 'quote' ? quoteLabel(chip.name) : chip.name}`
  }
  el.append(main)
  if (attach) {
    // 状态固定在末尾：路径太长时只截断路径，状态还看得见；没有状态时是空的
    const status = document.createElement('span')
    status.dataset.chipStatus = ''
    status.className = cn('shrink-0 text-[0.6875rem]', tone.status)
    status.textContent = shown?.status ?? ''
    el.append(status)
  }
  // 每张卡片都能点右上角删除：附件交给页面去掉（连同上传的文件），其他的直接从输入框里拿掉
  el.append(
    closeNode(() => {
      // 重新取一次：卡片画出来以后附件可能才传完，创建时拿到的 actions 里还没有这张图的附件
      const now = actions?.()
      if (attach && now?.remove) return now.remove(chip.name)
      const root = el.closest('[contenteditable="true"]')
      el.remove()
      root?.dispatchEvent(new Event('input', { bubbles: true }))
    }),
  )
  return el
}

/** 一段带标记的文字对应的 DOM 节点：标记变成真卡片 */
function nodesOf(value: string, preview?: Preview, actions?: () => ChipActions | undefined, info?: Info): Node[] {
  return segments(value).map((s) =>
    'text' in s ? document.createTextNode(s.text) : chipNode(s.chip, preview, actions, info),
  )
}

/** 按文字重新画一遍输入框 */
function paint(
  root: HTMLElement,
  value: string,
  preview?: Preview,
  actions?: () => ChipActions | undefined,
  info?: Info,
) {
  root.replaceChildren(...nodesOf(value, preview, actions, info))
}

/**
 * 附件状态变了（查找中 → 拷贝中 → 已拷贝或引用路径）：只改卡片上的文字，不重画整棵。
 * 重画会把所有卡片和文字换成新节点，打断输入法，光标还得靠重设选区恢复
 */
function updateChipInfo(root: HTMLElement, info?: Info) {
  if (!info) return
  for (const chip of root.querySelectorAll<HTMLElement>('[data-chip]')) {
    const shown = info({ kind: chip.dataset.chip as ChipKind, name: chip.dataset.name ?? '' })
    if (!shown) continue
    if (shown.title && chip.title !== shown.title) chip.title = shown.title
    const main = chip.querySelector<HTMLElement>('[data-chip-main]')
    if (main) {
      // 首次插入时 main 里是文件名占位：换成 @路径 + 大小
      main.className = 'min-w-0 truncate'
      if (main.textContent !== shown.label) main.textContent = shown.label
    }
    const status = chip.querySelector<HTMLElement>('[data-chip-status]')
    if (status && status.textContent !== (shown.status ?? '')) status.textContent = shown.status ?? ''
  }
}

/**
 * 文字没变、只是上传完成有了缩略图：只把图片卡片换成缩略图，不重画整棵。
 * 重画会把所有卡片和文字换成新节点，打断输入法的组合，光标还得靠重设选区恢复
 */
function updatePreviews(root: HTMLElement, preview?: Preview) {
  if (!preview) return
  for (const chip of root.querySelectorAll<HTMLElement>('[data-chip="image"]')) {
    const src = preview(chip.dataset.name ?? '')
    if (!src) continue
    const img = chip.querySelector('img')
    if (img) {
      if (img.getAttribute('src') !== src) img.src = src
      continue
    }
    // 上传完成前只有类型图标：就地换成缩略图
    const icon = chip.firstElementChild
    if (!icon || icon.tagName === 'IMG') continue
    const next = document.createElement('img')
    next.alt = ''
    next.className = 'h-[1.25em] w-[1.25em] shrink-0 rounded-sm object-cover'
    next.src = src
    icon.replaceWith(next)
  }
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
  actions,
  copyOf,
  info,
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
  /** 卡片上的操作：点卡片打开查看、点右上角删除 */
  actions?: ChipActions
  /**
   * 卡片复制到剪贴板时的文字（选中卡片按 Ctrl+C 用）：和右键菜单「复制内容 / 复制路径」一致。
   * 不传或返回 undefined 时用卡片标记。卡片在页面上的文字是截断过的摘要（引用卡片只显示前 40 个字），
   * 不能靠浏览器原生复制：那样带出去的是摘要，原文和标记都丢了
   */
  copyOf?: (chip: Chip) => string | undefined
  /** 附件卡片上的 @路径、大小和状态；不传时按卡片名显示 */
  info?: Info
}) {
  const el = useRef<HTMLDivElement>(null)
  // 最后一次画进 DOM 的内容：自己输入引起的变化不再画一遍，否则光标会跳。
  // 预览地址、卡片信息也要记：上传完成、拷贝状态变了时只换那一处，不重画整棵（见 updatePreviews / updateChipInfo）
  const painted = useRef<{ value: string; preview?: Preview; info?: Info } | null>(null)
  /** 输入法组合中：这时候不重画（会打断输入法），组合结束再补 */
  const composing = useRef(false)
  const [composeEnd, setComposeEnd] = useState(0)
  const cb = useRef({ onChange, onSync, onKeyDown, onPaste, preview, actions, copyOf, info })
  cb.current = { onChange, onSync, onKeyDown, onPaste, preview, actions, copyOf, info }

  /**
   * 选中卡片复制 / 剪切时按卡片的真实内容写剪贴板：浏览器原生复制拿到的是卡片上截断过的摘要
   * （引用卡片只显示前 40 个字），粘回去原文和标记都没了。
   * 两种格式一起写：text/plain 给面板自己的输入框还原卡片，text/html 给 Word、Excel 保住换行和缩进。
   * 返回选中的 range 和在文字里的起点，剪切要用它们删掉内容、把光标留在删完的位置；
   * 没选中输入框里的东西时返回 null，交给浏览器原生行为
   */
  const copySelection = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    const node = el.current
    const sel = window.getSelection()
    if (!node || !sel || !sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (r.collapsed || !node.contains(r.commonAncestorContainer)) return null
    setClipboardText(
      e.clipboardData,
      serialize(r.cloneContents(), (chip) => cb.current.copyOf?.(chip)),
    )
    const before = document.createRange()
    before.selectNodeContents(node)
    before.setEnd(r.startContainer, r.startOffset)
    return { range: r, at: serialize(before.cloneContents()).length }
  }, [])

  const emit = useCallback(() => {
    const node = el.current
    if (!node) return
    // 全删光之后浏览器会留一个占位的 <br>：它不是用户换的行（换行是自己插的文字），
    // 留着会读成「\n」，草稿不算空，拖进来的引用也会落到第二行
    if (node.childNodes.length === 1 && node.firstChild?.nodeName === 'BR') node.replaceChildren()
    const next = serialize(node)
    painted.current = { value: next, preview: cb.current.preview, info: cb.current.info }
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
    // 程序设的光标浏览器不会帮着滚，内容变多后光标可能落在可视区外
    scrollCaretIntoView(node)
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
      scrollCaretIntoView(node)
      emit()
    }
    return {
      text: () => serialize(el.current ?? document.createElement('div')),
      caret: () => caretNow(),
      setCaret: (pos) => place(pos),
      insert: (text) => put(nodesOf(text, cb.current.preview, () => cb.current.actions, cb.current.info)),
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
        const chipEl = chipNode(chip, cb.current.preview, () => cb.current.actions, cb.current.info)
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
        scrollCaretIntoView(node)
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
          nodesOf(text, cb.current.preview, () => cb.current.actions, cb.current.info).forEach((n) => frag.append(n))
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
        scrollCaretIntoView(node)
        emit()
      },
      setText: (text) => {
        const node = el.current
        if (!node) return
        paint(node, text, cb.current.preview, () => cb.current.actions, cb.current.info)
        painted.current = { value: text, preview: cb.current.preview, info: cb.current.info }
        cb.current.onChange(text)
        cb.current.onSync?.()
        place(Number.MAX_SAFE_INTEGER)
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
      paint(node, next, cb.current.preview, () => cb.current.actions, cb.current.info)
      painted.current = { value: next, preview: cb.current.preview, info: cb.current.info }
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

  // 内容、预览或卡片信息变了就重画：自己输入引起的那次已经和 DOM 一致，跳过（光标不跳）
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    if (painted.current?.value === value) {
      // 文字没变：只可能是上传完成有了缩略图、附件状态变了，换那一处就够了，不重画整棵
      if (painted.current.info !== info) {
        painted.current = { ...painted.current, info }
        updateChipInfo(node, info)
      }
      if (painted.current.preview !== preview) {
        painted.current = { ...painted.current, preview }
        updatePreviews(node, preview)
      }
      return
    }
    // 输入法组合中不重画：重画会把组合里的字擦掉、打断输入法；组合结束后由 onCompositionEnd 再跑一次
    if (composing.current) return
    const focused = document.activeElement === node
    const at = focused ? caretNow() : -1
    paint(node, value, preview, () => cb.current.actions, info)
    painted.current = { value, preview, info }
    if (at >= 0) place(Math.min(at, serialize(node).length))
  }, [value, preview, info, caretNow, place, composeEnd])

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
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
          // 组合结束后再补一次重画：组合期间跳过的那些变化在这里落地
          setTimeout(() => setComposeEnd((x) => x + 1), 0)
        }}
        onBlur={() => {
          // 组合中切走窗口、输入法异常时 compositionend 可能不来：不在这里清掉，之后的回车会一直被当成组合中而失效
          composing.current = false
        }}
        onKeyDown={(e) => {
          // 输入法组合中的按键（含选字用的回车）全部交给输入法，外部按键处理只看这里的 composing 记录：
          // 部分 Windows 输入法 compositionend 和 keydown 顺序交错，这时 nativeEvent.isComposing 还是 true，
          // 照着它过滤会把「中文输入完按的第一下回车」当成组合中的按键吞掉，消息就发不出去
          if (composing.current) return
          if (cb.current.onKeyDown?.(e)) return
          if (e.defaultPrevented) return
          if (e.key === 'Backspace' || e.key === 'Delete') {
            const chip = chipBeside(e.key === 'Backspace' ? -1 : 1)
            if (!chip) return
            e.preventDefault()
            dropAtChip(chip)
            return
          }
          // 换行自己插：浏览器插出来的 <div>、<br> 读回来不好还原
          if (e.key === 'Enter' && e.shiftKey) {
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
        onCopy={(e) => {
          if (copySelection(e)) e.preventDefault()
        }}
        onCut={(e) => {
          const cut = copySelection(e)
          if (!cut) return
          // 拦下原生剪切就得自己删：原生剪切删完以后浏览器再把同样的内容写一遍剪贴板，又是那段摘要。
          // 删完走 emit，让卡片背后的附件跟着去掉（onChange 按卡片名字对账）
          e.preventDefault()
          cut.range.deleteContents()
          emit()
          place(cut.at)
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
