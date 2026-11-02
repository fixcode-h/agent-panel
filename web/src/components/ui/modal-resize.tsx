import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import {
  clampDialogSize,
  modalSizeBounds,
  modalSizeKey,
  readModalSize,
  resizeDialogSize,
  writeModalSize,
  type DialogSize,
  type ResizeDirection,
} from '@/lib/modal-size'

/**
 * 弹窗尺寸的本地记忆：隐私模式下连访问 localStorage 都可能抛错，统一在这里兜住。
 * 写不进去时静默跳过——尺寸照样能拖，只是下次不恢复。
 */
function localStore(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** 当前视口能放的弹窗尺寸（四周各留 30px） */
function viewportBounds() {
  return modalSizeBounds(window.innerWidth, window.innerHeight)
}

/**
 * 从 D.Content 的 aria-labelledby 读弹窗标题。
 * bare 弹窗（title 传 null）的标题在调用方画的 ModalHeader / D.Title 里，拿不到字符串 prop 时用它区分记忆；
 * Radix 会给 Content 挂上指向 D.Title 的 aria-labelledby，布局阶段就已经在 DOM 上。
 */
function domDialogTitle(el: HTMLElement | null): string {
  if (!el) return ''
  const id = el.getAttribute('aria-labelledby')
  if (!id) return ''
  return el.ownerDocument.getElementById(id)?.textContent?.trim() ?? ''
}

export interface ModalResizeState {
  /** 挂到 D.Content 上：拖拽开始时按它的实际尺寸算起点 */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** 拖动过、或者恢复过记忆尺寸时才给：首次打开仍用尺寸档的原样式 */
  contentStyle: CSSProperties | undefined
  begin: (
    dirX: ResizeDirection,
    dirY: ResizeDirection,
    cursor: string,
  ) => (e: ReactPointerEvent<HTMLDivElement>) => void
  move: (e: ReactPointerEvent<HTMLDivElement>) => void
  end: (e: ReactPointerEvent<HTMLDivElement>) => void
}

/**
 * 弹窗拖拽调整大小：四边 + 四角、记忆在本机、受最小尺寸和视口约束。
 * Modal 和 ConfirmDialog 共用，调用方不用各自实现。
 *
 * @param title 用于生成记忆键（尺寸档 + 标题）；显式传 resizeKey 时以它为准
 */
export function useModalResize({
  open,
  title,
  tier,
  resizeKey,
}: {
  open: boolean
  title: unknown
  tier: string
  resizeKey?: string
}): ModalResizeState {
  // 非字符串标题（bare 弹窗传 null、富标题 JSX）先用 DOM 里的实际标题兜底，避免同档弹窗共用一份记忆
  const [domTitle, setDomTitle] = useState('')
  // 最新的 title 放 ref：可能每次渲染都是新的 JSX，放进 effect 依赖会让拖拽过程中反复重算并重置尺寸
  const titleRef = useRef(title)
  titleRef.current = title
  const key = modalSizeKey(resizeKey, typeof title === 'string' ? title : domTitle, tier)
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<DialogSize | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const sizeRef = useRef<DialogSize | null>(null)
  const drag = useRef<{
    start: DialogSize
    x: number
    y: number
    dirX: ResizeDirection
    dirY: ResizeDirection
    /** 是否真的移动过：只点一下手柄时不能改变尺寸，也不能把最小高度套到小弹窗上 */
    moved: boolean
  } | null>(null)

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  // 每次打开（或标题变了 → 换成另一个弹窗）都恢复它自己的尺寸；用 layout effect 避免先按默认尺寸画一帧再跳
  useLayoutEffect(() => {
    if (!open) return
    const current = titleRef.current
    // 标题不是字符串时从 DOM 取 D.Title 的实际文字：布局阶段 Radix 已经挂好 aria-labelledby
    const text = typeof current === 'string' ? current : domDialogTitle(contentRef.current)
    if (typeof current !== 'string' && text !== domTitle) {
      setDomTitle(text)
      return
    }
    const store = localStore()
    const stored = store ? readModalSize(store, modalSizeKey(resizeKey, text, tier)) : null
    setSize(stored ? clampDialogSize(stored, viewportBounds()) : null)
  }, [open, key, domTitle, resizeKey, tier])

  // 窗口缩小时把当前尺寸收进新的视口，不只限制拖动
  useEffect(() => {
    if (!open) return
    const onResize = () => setSize((s) => (s ? clampDialogSize(s, viewportBounds()) : s))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // 弹窗关掉时复位拖拽：D.Content 卸载后手柄收不到 pointerup，不清的话全局光标和禁止选中会一直挂着
  useEffect(() => {
    if (open) return
    drag.current = null
    setCursor(null)
  }, [open])

  // 拖拽期间锁住全局光标和文字选中：指针滑出拖动条、经过内容文字也不变成文本光标
  useEffect(() => {
    if (!cursor) return
    const root = document.documentElement
    root.dataset.modalResizing = 'true'
    root.style.setProperty('--modal-resize-cursor', cursor)
    return () => {
      delete root.dataset.modalResizing
      root.style.removeProperty('--modal-resize-cursor')
    }
  }, [cursor])

  const begin: ModalResizeState['begin'] = (dirX, dirY, cursorValue) => (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = contentRef.current
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    // 用布局尺寸而不是 getBoundingClientRect：打开动画 300ms 内带缩放，rect 会把起点量小
    const start = clampDialogSize({ w: el.offsetWidth, h: el.offsetHeight }, viewportBounds())
    drag.current = { start, x: e.clientX, y: e.clientY, dirX, dirY, moved: false }
    setCursor(cursorValue)
  }

  const move: ModalResizeState['move'] = (e) => {
    const d = drag.current
    if (!d) return
    d.moved = true
    setSize(resizeDialogSize(d.start, d.dirX, d.dirY, e.clientX - d.x, e.clientY - d.y, viewportBounds()))
  }

  const end: ModalResizeState['end'] = (e) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setCursor(null)
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
    // 只按下、没拖动（误点手柄）：不改尺寸也不写记忆
    if (!d.moved) return
    // pointercancel 的坐标可能是 0，这时保留最后一次 move 算出来的尺寸
    const final =
      e.type === 'pointercancel' && sizeRef.current
        ? sizeRef.current
        : resizeDialogSize(d.start, d.dirX, d.dirY, e.clientX - d.x, e.clientY - d.y, viewportBounds())
    setSize(final)
    const store = localStore()
    if (store) writeModalSize(store, key, final)
  }

  const bounds = typeof window === 'undefined' ? null : viewportBounds()
  const contentStyle: CSSProperties | undefined =
    size && bounds
      ? {
          width: size.w,
          height: size.h,
          minWidth: bounds.minW,
          minHeight: bounds.minH,
          maxWidth: bounds.maxW,
          maxHeight: bounds.maxH,
        }
      : undefined

  return { contentRef, contentStyle, begin, move, end }
}

interface HandleSpec {
  key: string
  dirX: ResizeDirection
  dirY: ResizeDirection
  cursor: string
  className: string
  orientation?: 'horizontal' | 'vertical'
  label: string
}

/**
 * 弹窗四边 + 四角的手柄：贴在外壳内侧，透明，悬停时亮一条浅色；
 * 角落盖在边上（z-30），拖到角优先按等比缩放处理。
 */
export function ModalResizeHandles({ resize }: { resize: ModalResizeState }) {
  const specs: HandleSpec[] = [
    {
      key: 'n',
      dirX: 0,
      dirY: -1,
      cursor: 'row-resize',
      className: 'inset-x-3 top-0 h-1.5 cursor-row-resize',
      orientation: 'horizontal',
      label: t('拖动调整高度'),
    },
    {
      key: 's',
      dirX: 0,
      dirY: 1,
      cursor: 'row-resize',
      className: 'inset-x-3 bottom-0 h-1.5 cursor-row-resize',
      orientation: 'horizontal',
      label: t('拖动调整高度'),
    },
    {
      key: 'w',
      dirX: -1,
      dirY: 0,
      cursor: 'col-resize',
      className: 'inset-y-3 left-0 w-1.5 cursor-col-resize',
      orientation: 'vertical',
      label: t('拖动调整宽度'),
    },
    {
      key: 'e',
      dirX: 1,
      dirY: 0,
      cursor: 'col-resize',
      className: 'inset-y-3 right-0 w-1.5 cursor-col-resize',
      orientation: 'vertical',
      label: t('拖动调整宽度'),
    },
    {
      key: 'nw',
      dirX: -1,
      dirY: -1,
      cursor: 'nwse-resize',
      className: 'top-0 left-0 z-30 h-3 w-3 cursor-nwse-resize',
      label: t('拖动调整大小'),
    },
    {
      key: 'ne',
      dirX: 1,
      dirY: -1,
      cursor: 'nesw-resize',
      className: 'top-0 right-0 z-30 h-3 w-3 cursor-nesw-resize',
      label: t('拖动调整大小'),
    },
    {
      key: 'sw',
      dirX: -1,
      dirY: 1,
      cursor: 'nesw-resize',
      className: 'bottom-0 left-0 z-30 h-3 w-3 cursor-nesw-resize',
      label: t('拖动调整大小'),
    },
    {
      key: 'se',
      dirX: 1,
      dirY: 1,
      cursor: 'nwse-resize',
      className: 'right-0 bottom-0 z-30 h-3 w-3 cursor-nwse-resize',
      label: t('拖动调整大小'),
    },
  ]
  return (
    <>
      {specs.map((s) => (
        <div
          key={s.key}
          data-modal-resize={s.key}
          role="separator"
          aria-orientation={s.orientation}
          aria-label={s.label}
          tabIndex={-1}
          className={cn('absolute z-20 touch-none transition-colors hover:bg-accent/30', s.className)}
          onPointerDown={resize.begin(s.dirX, s.dirY, s.cursor)}
          onPointerMove={resize.move}
          onPointerUp={resize.end}
          onPointerCancel={resize.end}
          // 没被卸载但丢了指针捕获（浏览器打断、捕获被别处抢走）时也收尾
          onLostPointerCapture={resize.end}
        />
      ))}
    </>
  )
}
