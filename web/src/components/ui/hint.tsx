import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAX_HINT_WIDTH_PX, place, type Placement } from '@/lib/hint-place'
import { cn } from '@/lib/utils'

/** 悬停多久弹出：太短时鼠标划过会到处乱闪，太长像没反应 */
const HOVER_DELAY_MS = 150
/** 指针离开后等这么久再关：留出从触发元素移到浮层上方的时间 */
const LEAVE_GRACE_MS = 250
/** 判断「指针还在不在上面」时往外放宽多少：从触发元素移到浮层上时会有一点偏差 */
const POINTER_SLACK_PX = 4

/**
 * 这些原生元素的 title 是浏览器自己的语义（下拉项说明、文档标题），换成浮层反而丢信息，不接管。
 */
const SKIP_TAGS = new Set(['IFRAME', 'OPTION', 'OPTGROUP', 'TITLE', 'STYLE', 'SCRIPT'])

/**
 * 记录指针最后的位置。
 * 浮层设了 pointer-events-none（否则会挡住鼠标下面的按钮，原生 title 从不挡），
 * 这时浮层收不到 :hover，所以要靠全局坐标自己判断「指针是不是还在浮层 / 触发元素上」。
 */
const lastPointer = { x: -1, y: -1 }
/**
 * 指针最近一次真正移动是多久以前（毫秒时间戳）。
 * 元素自己滑到静止的指针下面时（点开面板、焦点自动跳转）不该弹提示 —— 原生 title 也不会。
 */
let pointerMovedAt = 0
let pointerTracked = false
function trackPointer() {
  if (pointerTracked) return
  pointerTracked = true
  document.addEventListener(
    'pointermove',
    (e) => {
      // 位置没变的事件不算移动（点击、程序化派发）
      if (e.clientX === lastPointer.x && e.clientY === lastPointer.y) return
      lastPointer.x = e.clientX
      lastPointer.y = e.clientY
      pointerMovedAt = performance.now()
    },
    { passive: true, capture: true },
  )
}

/** 指针是不是落在这个元素的范围里（留一点容差，从触发元素移到浮层上时不会手抖漏掉） */
function pointerOn(el: Element | null): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return (
    lastPointer.x >= r.left - POINTER_SLACK_PX &&
    lastPointer.x <= r.right + POINTER_SLACK_PX &&
    lastPointer.y >= r.top - POINTER_SLACK_PX &&
    lastPointer.y <= r.bottom + POINTER_SLACK_PX
  )
}

/**
 * 焦点是不是 Tab 走过来的。
 * 键盘操作要能看到提示，但弹窗、下拉、参数面板打开时会把焦点自动挪到第一个可聚焦元素上，
 * 那里正好有提示，于是浮层自己弹出来（用户并没碰过它）。
 * Tab 的默认动作在同一个任务里就移完焦点，所以下一个任务清掉标记，程序化聚焦不会被当成键盘操作。
 */
let tabFocus = false
let tabTracked = false
function trackTabFocus() {
  if (tabTracked) return
  tabTracked = true
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab') return
      tabFocus = true
      setTimeout(() => {
        tabFocus = false
      }, 0)
    },
    true,
  )
}

/**
 * 打开着的提示按 Esc 关掉。
 * 不用 lib 里的 useEscape：它遇到 popover / dialog 开着时会主动让路（那是给抽屉用的规则），
 * 提示正好盖在这些浮层上面，让路之后就关不掉了。
 * 提示是最上层，所以 capture 阶段先处理，并吃掉这次按键，免得底下的弹窗跟着一起关。
 */
function useHintEscape(open: boolean, close: () => void) {
  const fn = useRef(close)
  fn.current = close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      fn.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])
}

/**
 * 浮层本体：所有提示共用这一份外观，别处不要再另写一套样式。
 * 悬停提示不放关闭按钮：鼠标一移开就自己消失，按钮反而占住右上角、还要处理焦点回收。
 * 需要手动关掉的是错误提示（sonner 的 toast），那边单独开 closeButton。
 */
function HintSurface({
  content,
  anchor,
  contentRef,
  className,
}: {
  content: React.ReactNode
  /** 贴着哪个元素的哪一面 */
  anchor: DOMRect
  contentRef: React.RefObject<HTMLDivElement | null>
  className?: string
}) {
  const [placement, setPlacement] = useState<Placement | null>(null)

  // 先渲染出来量尺寸再定位：位置依赖浮层自己的宽高（长文字会换行）
  useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return
    const r = node.getBoundingClientRect()
    setPlacement(
      place(anchor, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }),
    )
    // anchor 每次打开、滚动都会换一个新 DOMRect，靠它的数值判断要不要重算
  }, [anchor, anchor.left, anchor.top, anchor.width, anchor.height, contentRef])

  // 挂到 body：position: fixed 的包含块会被祖先的 transform 改掉（弹窗用 -translate-x-1/2 居中），
  // 留在原位置的话算好的视口坐标会被相对弹窗解释，浮层偏到别处、还会被弹窗的 overflow-hidden 裁掉。
  return createPortal(
    <div
      ref={contentRef}
      role="tooltip"
      // pointer-events-none：提示只是给鼠标用户看的补充，绝不能挡住下面的页面。
      // 原生 title 从不拦点击，换成浮层后如果吃指针事件，鼠标后面的按钮就点不到了。
      className={cn(
        // 量尺寸时先藏起来，避免在算好位置前闪一下
        'pointer-events-none fixed z-50 max-w-[320px] rounded-lg border border-line-strong bg-card px-3 py-2 text-xs leading-relaxed break-words text-muted shadow-pop',
        !placement && 'invisible',
        className,
      )}
      style={
        placement
          ? { left: placement.left, top: placement.top, maxWidth: MAX_HINT_WIDTH_PX }
          : { left: 0, top: 0, maxWidth: MAX_HINT_WIDTH_PX }
      }
    >
      {content}
    </div>,
    document.body,
  )
}

/** 把提示需要的事件接到触发元素上：调用点自己的处理器先跑，提示的接着跑，谁都不会被覆盖 */
function mergeHandler<T extends Event>(their: unknown, ours: (e: T) => void) {
  return (e: T) => {
    if (typeof their === 'function') (their as (e: T) => void)(e)
    ours(e)
  }
}

export interface HintProps {
  /** 触发元素：button / span / div / td 都行，不额外包 DOM */
  children: React.ReactElement<Record<string, unknown>>
  /** 提示内容，可以是文字也可以是几行结构 */
  content: React.ReactNode
  /** 浮层上追加的类名（个别地方要更宽） */
  className?: string
}

/**
 * 统一的悬停提示：鼠标移上去、键盘 Tab 过来或点一下触发元素都会弹出，指针移开自己消失。
 * 用它替换原生 title —— 原生提示的样式跟浏览器走、改不了，还是挡住内容的一条黑条。
 * 界面上已有的 title 由 GlobalHintHost 统一接管，新写的代码直接用它包住触发元素。
 * 控件自己的 aria-label 要另外留着：提示是给鼠标用户看的补充，不能当无障碍名称。
 */
export function Hint({ children, content, className }: HintProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef(0)
  const closeTimer = useRef(0)
  useEffect(trackTabFocus, [])
  useEffect(trackPointer, [])

  const clearTimers = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    openTimer.current = 0
    closeTimer.current = 0
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  /**
   * 打开提示。
   * byUser：用户主动的（点元素、Tab 过来）——直接开；
   * 否则是悬停，要先确认指针刚动过：元素自己移到静止的指针下面（点开面板、焦点自动跳到问号）
   * 不算用户要看提示，原生 title 也只会在鼠标真正停上去时出现。
   */
  const show = useCallback(
    (byUser: boolean) => {
      clearTimers()
      if (!byUser && performance.now() - pointerMovedAt > HOVER_DELAY_MS * 4) return
      const fire = () => {
        openTimer.current = 0
        const el = triggerRef.current
        if (el) setAnchor(el.getBoundingClientRect())
      }
      if (byUser) return fire()
      openTimer.current = window.setTimeout(fire, HOVER_DELAY_MS)
    },
    [clearTimers],
  )

  // 鼠标一下跳开、之后就停在那儿时收不到指针事件，浮层会留在屏幕上。
  // 所以等一会儿再确认指针既不在触发元素也不在浮层上，才真正关掉。
  const scheduleClose = useCallback(() => {
    clearTimers()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = 0
      if (triggerRef.current?.matches(':hover') || pointerOn(contentRef.current)) return
      setAnchor(null)
    }, LEAVE_GRACE_MS)
  }, [clearTimers])

  const dismiss = useCallback(() => {
    clearTimers()
    setAnchor(null)
    // 焦点回到触发元素：掉到 body 上以后键盘用户就找不到原来的位置了
    triggerRef.current?.focus({ preventScroll: true })
  }, [clearTimers])

  // Esc 关掉提示：提示可能盖在弹窗上面，而 useEscape 遇到 popover / dialog 会主动让路，
  // 所以这里自己在 capture 阶段处理，并且吃掉这次按键（不然底下的弹窗会跟着关）
  useHintEscape(!!anchor, dismiss)

  // 滚动、改窗口大小时位置会漂：跟着重算，浮层不能停在原来的地方
  useEffect(() => {
    if (!anchor) return
    const sync = () => {
      const el = triggerRef.current
      if (!el?.isConnected) return setAnchor(null)
      setAnchor(el.getBoundingClientRect())
    }
    window.addEventListener('scroll', sync, { capture: true, passive: true })
    window.addEventListener('resize', sync, { passive: true })
    return () => {
      window.removeEventListener('scroll', sync, { capture: true })
      window.removeEventListener('resize', sync)
    }
  }, [anchor])

  const own = children.props
  const trigger = {
    ...children,
    props: {
      ...own,
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node
        const their = own.ref as React.RefCallback<HTMLElement> | React.RefObject<HTMLElement | null> | undefined
        if (typeof their === 'function') their(node)
        else if (their) their.current = node
      },
      onPointerEnter: mergeHandler(own.onPointerEnter, () => show(false)),
      onPointerLeave: mergeHandler(own.onPointerLeave, scheduleClose),
      onFocus: mergeHandler<FocusEvent>(own.onFocus, () => {
        // 键盘 Tab 过来要看提示；弹窗把焦点挪过来（程序化聚焦）不算
        if (tabFocus) show(true)
      }),
      onBlur: mergeHandler<FocusEvent>(own.onBlur, scheduleClose),
      // 点一下也算明确要看提示（问号图标就该能点开）。
      // 但帮 Tip 常放在 <label> 里：不拦住的话点击会转发给关联的表单控件，输入框被莫名聚焦。
      onClick: mergeHandler(own.onClick, (e) => {
        const ev = e as unknown as React.MouseEvent
        ev.preventDefault()
        ev.stopPropagation()
        show(true)
      }),
    },
  } as React.ReactElement<Record<string, unknown>>

  return (
    <>
      {trigger}
      {anchor && <HintSurface content={content} anchor={anchor} className={className} contentRef={contentRef} />}
    </>
  )
}

type TipState = { text: string; el: HTMLElement; rect: DOMRect }

/** 按坐标命中带提示的元素，包含 pointer-events: none 的那些（disabled 按钮） */
function pickByRect(x: number, y: number): HTMLElement | null {
  let found: HTMLElement | null = null
  for (const el of document.querySelectorAll<HTMLElement>('[title], [data-hint]')) {
    if (SKIP_TAGS.has(el.tagName)) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    // 有多个重叠时报取最靠上的那个（DOM 顺序靠后的一般画在上面）
    found = el
  }
  return found
}

/**
 * 元素是不是还露在最上面。
 * 新打开一个弹窗、下拉、popover 之后，原触发元素被盖在下面，指针没动也收不到事件，
 * 只能靠坐标取一次最顶层的节点来判断。
 */
function stillOnTop(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return false
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !!top && (top === el || el.contains(top))
}

/**
 * 把 title 暂存在 data-hint 里并摘掉：浏览器就不会再弹它自己那条黑条，而提示文字还留着可读。
 * 关闭后还原，静态 DOM 里 title 原样在 —— 界面检查和以后写用例按 title 定位都不受影响。
 */
function hideTitle(el: HTMLElement): string | null {
  const saved = el.dataset.hint
  if (saved !== undefined) return saved
  const text = el.getAttribute('title')
  if (!text || !text.trim()) return null
  el.dataset.hint = text
  el.removeAttribute('title')
  return text
}

function restoreTitle(el: HTMLElement) {
  const saved = el.dataset.hint
  if (saved === undefined) return
  delete el.dataset.hint
  // 期间 React 又写过 title 的话以它为准，别用旧值盖掉
  if (!el.hasAttribute('title')) el.setAttribute('title', saved)
}

/**
 * 在 App 根部挂一次，接管全界面原生 title：鼠标停到任何带 title 的元素上，用统一样式的浮层显示。
 *
 * 为什么在 DOM 层统一接管，而不是逐个改 JSX：
 * 组件 props 上的 title（ConfirmDialog / FormSection / Modal 这些弹窗和区块标题）根本不渲染成
 * DOM 属性，只有真正落到元素上的 title 才是浏览器那条黑条 —— 在 DOM 层一次就能把两者分开，
 * 调用点一行都不用改，以后调样式也只改这里。
 */
export function GlobalHintHost() {
  const [tip, setTip] = useState<TipState | null>(null)
  const tipRef = useRef<TipState | null>(null)
  /** 刚被点击的元素：用户是在用它（例如点开参数面板），这一轮悬停里不再弹它的提示 */
  const clickedEl = useRef<HTMLElement | null>(null)
  const hoveredEl = useRef<HTMLElement | null>(null)
  const openTimer = useRef(0)
  const closeTimer = useRef(0)
  const rafId = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const pointer = useRef({ x: 0, y: 0 })
  useEffect(trackTabFocus, [])
  useEffect(trackPointer, [])

  const setTipState = useCallback((next: TipState | null) => {
    tipRef.current = next
    setTip(next)
  }, [])

  const clearTimers = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    openTimer.current = 0
    closeTimer.current = 0
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  /** 关闭浮层：把 title 还回去，下次悬停还能重新弹出来 */
  const closeTip = useCallback(() => {
    const cur = tipRef.current
    if (cur) restoreTitle(cur.el)
    setTipState(null)
  }, [setTipState])

  const dismiss = useCallback(() => {
    const el = tipRef.current?.el ?? null
    clickedEl.current = el
    clearTimers()
    closeTip()
    // 焦点回到触发元素：掉到 body 上以后键盘用户就找不到原来的位置了
    el?.focus({ preventScroll: true })
  }, [clearTimers, closeTip])

  // Esc 关掉提示：理由同 Hint —— useEscape 遇到 popover / dialog 会主动让路
  useHintEscape(!!tip, dismiss)

  // 鼠标一下跳开、之后就停在那儿时收不到指针事件，浮层会留在屏幕上。
  // 所以等一会儿再确认指针既不在浮层上、也不在这个元素上，才真正关掉。
  const scheduleClose = useCallback(() => {
    clearTimers()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = 0
      const cur = tipRef.current
      // 浮层不吃指针事件，所以靠坐标判断指针还在不在它 / 触发元素上，离开才真关
      if (pointerOn(contentRef.current) || (cur && pointerOn(cur.el))) return
      closeTip()
    }, LEAVE_GRACE_MS)
  }, [clearTimers, closeTip])

  useEffect(() => {
    /**
     * 按坐标找这一点的提示元素。
     * 用 elementsFromPoint 而不是事件 target：disabled 的按钮自己不派发鼠标事件，原生 title 却还能显示，
     * 按坐标取才找得到它。
     */
    const findAt = (x: number, y: number): HTMLElement | null => {
      const pick = (node: Element | null): HTMLElement | null => {
        const el = (node?.closest('[title], [data-hint]') ?? null) as HTMLElement | null
        return el && !SKIP_TAGS.has(el.tagName) ? el : null
      }
      // 按坐标取是在绕过 disabled 的限制：disabled 的按钮自己不派发鼠标事件，原生 title 却还能显示。
      // elementsFromPoint / elementFromPoint 都会跳过 pointer-events: none 的元素，
      // 而 Button 一禁用就带 disabled:pointer-events-none —— 那样 disabled 按钮的提示就永远出不来。
      // 所以先用它们逐层找（快、覆盖大部分情况），拿不到再退回到「按矩形命中」扫一遍。
      for (const node of document.elementsFromPoint(x, y)) {
        const el = pick(node)
        if (el) return el
      }
      return pickByRect(x, y)
    }

    /**
     * 延时到了真的显示之前再确认一次指针还停在这个元素上。
     * 等的这 150ms 里点开的面板可能已经盖住它、列表可能已经重排，这时候原生 title 也不会显示
     * （浮层却会自己冒出来，正好盖在刚打开的面板上）。
     */
    const open = (el: HTMLElement) => {
      openTimer.current = 0
      // 这个元素刚被点过（例如点开参数面板）：用户是在用它，不是在等提示
      if (clickedEl.current === el) return
      // 指针这期间没真动过：元素自己滑到了指针下面，不是用户要看的提示
      if (performance.now() - pointerMovedAt > HOVER_DELAY_MS * 4) {
        hoveredEl.current = null
        return
      }
      if (!el.isConnected || findAt(pointer.current.x, pointer.current.y) !== el) {
        hoveredEl.current = null
        return
      }
      const text = hideTitle(el)
      if (!text) return
      // 打开这一刻再取一次位置：等的这 150ms 里页面可能滚过、动过
      setTipState({ text, el, rect: el.getBoundingClientRect() })
    }

    const onMove = (e: PointerEvent) => {
      // 触摸没有悬停这回事，title 保持原样
      if (e.pointerType !== 'mouse') return
      pointer.current = { x: e.clientX, y: e.clientY }
      if (rafId.current) return
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0
        const el = findAt(pointer.current.x, pointer.current.y)
        if (el === hoveredEl.current) return
        const prev = hoveredEl.current
        hoveredEl.current = el
        // 指针离开了刚才点的那个元素：可以按普通悬停重新算
        if (clickedEl.current && clickedEl.current !== el) clickedEl.current = null
        clearTimers()
        // 换了元素：上一个浮层收起来，title 还回去（指针已经不在它上面，不会弹黑条）
        if (tipRef.current && tipRef.current.el !== el) closeTip()
        if (prev && prev !== el) restoreTitle(prev)
        if (!el) return
        openTimer.current = window.setTimeout(() => open(el), HOVER_DELAY_MS)
      })
    }

    // 指针移出窗口时没有后续的 pointermove，浮层会一直留着
    const onLeaveWindow = () => {
      hoveredEl.current = null
      scheduleClose()
    }
    // 滚动、改窗口大小时位置会漂：按元素当前位置重算，浮层不能停在原来的地方
    const reposition = () => {
      const cur = tipRef.current
      if (!cur) return
      if (!cur.el.isConnected) return closeTip()
      setTipState({ ...cur, rect: cur.el.getBoundingClientRect() })
    }

    /**
     * 浮层开着的时候 React 可能按 props 把 title 写回来（例如状态变化改了提示文案），
     * 一旦写回浏览器就会同时弹出原生黑条。所以盯着 title 属性的写回，是当前这个元素就再摘一次。
     */
    const observer = new MutationObserver((records) => {
      // 触发元素被卸载（切页、删列表项），或者被新打开的弹窗 / 下拉盖住了：
      // 浮层必须跟着消失。后者没有 pointermove 事件，只能靠 DOM 变化发现，
      // 否则刚点开的面板上会留着一个旧提示（内容还和眼前的界面无关）。
      const cur = tipRef.current
      if (cur && (!cur.el.isConnected || !stillOnTop(cur.el))) closeTip()
      for (const r of records) {
        if (r.attributeName !== 'title' || !(r.target instanceof HTMLElement)) continue
        const el = r.target
        // 只关心「浮层正对着的那个元素」被 React 写回 title
        const shown = tipRef.current
        if (!shown || shown.el !== el) continue
        const text = el.getAttribute('title')
        if (text === null) continue
        // 写回就再摘一次，文案变了浮层也跟着换
        el.dataset.hint = text
        el.removeAttribute('title')
        if (text !== shown.text) setTipState({ ...shown, text, rect: el.getBoundingClientRect() })
      }
    })
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    })

    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeaveWindow, { passive: true })
    // 点过的元素这一轮悬停里不再弹提示：点开面板后指针还停在按钮上，提示不该冒出来盖住面板
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const el = findAt(e.clientX, e.clientY)
      if (el) clickedEl.current = el
    }
    document.addEventListener('pointerdown', onDown, { passive: true, capture: true })
    window.addEventListener('scroll', reposition, { capture: true, passive: true })
    window.addEventListener('resize', reposition, { passive: true })
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeaveWindow)
      document.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('scroll', reposition, { capture: true })
      window.removeEventListener('resize', reposition)
      if (rafId.current) cancelAnimationFrame(rafId.current)
      observer.disconnect()
      const cur = tipRef.current
      if (cur) restoreTitle(cur.el)
      if (hoveredEl.current) restoreTitle(hoveredEl.current)
      clearTimers()
    }
  }, [clearTimers, closeTip, scheduleClose, setTipState])

  return tip ? <HintSurface content={tip.text} anchor={tip.rect} contentRef={contentRef} /> : null
}
