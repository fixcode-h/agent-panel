// 开发者模式的「元素抓取」：输入框上的按钮进入抓取模式，像浏览器开发者工具的「选择元素」一样，
// 鼠标移到哪里就框住哪个元素，左键点一下把它写成引用放进输入框并退出，Esc 或右键直接退出。
// 引用怎么写见 lib/element-ref.ts，源码位置来自构建时写进 DOM 的 data-src（scripts/lib/source-loc.mjs）
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { SquareDashedMousePointer } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useData } from '@/lib/data'
import {
  componentChain,
  formatElementRef,
  parseLoc,
  pickStyles,
  type ElementInfo,
  type SourceLoc,
} from '@/lib/element-ref'
import { t } from '@shared/i18n'

/** 写进引用的属性：能帮 AI 搜到这个元素的那些 */
const ATTRS = ['id', 'role', 'aria-label', 'title', 'placeholder', 'type', 'name', 'href', 'alt', 'data-state']
/** 选择器里优先用来认元素的属性（比 tailwind 的一堆 class 稳） */
const KEY_ATTRS = ['aria-label', 'role', 'data-wid', 'name', 'placeholder', 'title']

type Fiber = { type: unknown; memoizedProps?: Record<string, unknown>; return: Fiber | null }

/** React 挂在 DOM 节点上的 fiber（正式包里也有） */
function fiberOf(el: Element): Fiber | undefined {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  return key ? ((el as unknown as Record<string, Fiber>)[key] ?? undefined) : undefined
}

/**
 * 由内到外的各层位置：沿 fiber 往上走（弹窗、菜单是 portal，DOM 上不在原组件里面，fiber 上在），
 * 不是 React 渲染的节点（Markdown 里的 HTML）先往上找到 React 的节点
 */
function locsOf(el: Element): SourceLoc[] {
  let host: Element | null = el
  while (host && !fiberOf(host)) host = host.parentElement
  const out: SourceLoc[] = []
  if (host) {
    for (let f: Fiber | null = fiberOf(host) ?? null; f; f = f.return) {
      if (typeof f.type !== 'string') continue
      const loc = parseLoc(f.memoizedProps?.['data-src'] as string | undefined)
      if (loc) out.push(loc)
    }
    return out
  }
  for (let p: Element | null = el; p; p = p.parentElement) {
    const loc = parseLoc(p.getAttribute('data-src'))
    if (loc) out.push(loc)
  }
  return out
}

/** 一段短的 CSS 选择器：往上最多 4 层，有 id 就停；没有好认的属性时用 nth-of-type */
function selectorOf(el: Element) {
  const parts: string[] = []
  let cur: Element | null = el
  for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
    const tag = cur.tagName.toLowerCase()
    if (cur.id) {
      parts.unshift(`${tag}#${CSS.escape(cur.id)}`)
      break
    }
    const node: Element = cur
    const key = KEY_ATTRS.find((a) => {
      const v = node.getAttribute(a)
      return !!v && v.length <= 40 && !/[\n"]/.test(v)
    })
    let s = tag
    if (key) s += `[${key}="${node.getAttribute(key)}"]`
    else {
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : []
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(node) + 1})`
    }
    parts.unshift(s)
    if (tag === 'body') break
  }
  return parts.join(' > ')
}

/** 从 DOM 读出元素信息 */
export function describeElement(el: Element): ElementInfo {
  const locs = locsOf(el)
  const own = parseLoc(el.getAttribute('data-src'))
  const source = own ?? (locs[0] ? { ...locs[0], inherited: true } : undefined)
  const rect = el.getBoundingClientRect()
  const css = getComputedStyle(el)
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const widget = el.closest('[data-wid]')
  return {
    tag: el.tagName.toLowerCase(),
    attrs: ATTRS.flatMap((a) => {
      const v = el.getAttribute(a)
      return v ? [[a, v] as [string, string]] : []
    }),
    className: el.getAttribute('class') ?? '',
    text: (el instanceof HTMLElement ? el.innerText : el.textContent) ?? '',
    width: rect.width,
    height: rect.height,
    source,
    chain: componentChain(locs),
    selector: selectorOf(el),
    styles: pickStyles((p) => css.getPropertyValue(p), rootPx),
    page: location.hash || location.pathname,
    widget: widget
      ? { id: widget.getAttribute('data-wid') ?? '', type: widget.getAttribute('data-type') ?? undefined }
      : undefined,
  }
}

/** 浮在元素上的标签：标签名、组件名、尺寸，和浏览器开发者工具里的一样 */
function labelOf(el: Element) {
  const loc = parseLoc(el.getAttribute('data-src')) ?? locsOf(el)[0]
  const widget = el.closest('[data-wid]')
  return {
    tag: el.tagName.toLowerCase(),
    name: widget ? (widget.getAttribute('data-type') ?? '') : (loc?.component ?? ''),
  }
}

/** 抓取模式期间吞掉的鼠标事件：不让页面上的按钮、菜单、拖动被触发 */
const SWALLOW = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick'] as const

function PickOverlay({
  trigger,
  onPick,
  onExit,
}: {
  /** 进入抓取的那个按钮：抓取时再点它就是退出 */
  trigger: RefObject<HTMLElement | null>
  onPick: (el: Element) => void
  onExit: () => void
}) {
  const [box, setBox] = useState<{ rect: DOMRect; tag: string; name: string } | null>(null)
  const target = useRef<Element | null>(null)
  const cb = useRef({ onPick, onExit })
  cb.current = { onPick, onExit }
  useEffect(() => {
    const show = () => {
      const el = target.current
      setBox(el?.isConnected ? { rect: el.getBoundingClientRect(), ...labelOf(el) } : null)
    }
    const at = (e: MouseEvent) => document.elementFromPoint(e.clientX, e.clientY)
    const move = (e: PointerEvent) => {
      const el = at(e)
      if (el === target.current) return
      target.current = el
      show()
    }
    const swallow = (e: Event) => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const click = (e: MouseEvent) => {
      swallow(e)
      if (e.button !== 0) return
      const el = at(e)
      if (!el || trigger.current?.contains(el)) return cb.current.onExit()
      cb.current.onPick(el)
    }
    const menu = (e: MouseEvent) => {
      swallow(e)
      cb.current.onExit()
    }
    // Esc 只退出抓取：在捕获阶段拦下，不让对话页的 Esc（停止对话、关弹窗）也收到
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      swallow(e)
      cb.current.onExit()
    }
    const leave = (e: MouseEvent) => {
      if (e.relatedTarget) return
      target.current = null
      show()
    }
    const opts = { capture: true }
    window.addEventListener('pointermove', move, opts)
    window.addEventListener('click', click, opts)
    window.addEventListener('contextmenu', menu, opts)
    window.addEventListener('keydown', key, opts)
    window.addEventListener('scroll', show, { capture: true, passive: true })
    window.addEventListener('resize', show)
    document.addEventListener('mouseout', leave)
    for (const n of SWALLOW) window.addEventListener(n, swallow, opts)
    return () => {
      window.removeEventListener('pointermove', move, opts)
      window.removeEventListener('click', click, opts)
      window.removeEventListener('contextmenu', menu, opts)
      window.removeEventListener('keydown', key, opts)
      window.removeEventListener('scroll', show, { capture: true })
      window.removeEventListener('resize', show)
      document.removeEventListener('mouseout', leave)
      for (const n of SWALLOW) window.removeEventListener(n, swallow, opts)
    }
  }, [trigger])

  const r = box?.rect
  // 标签放在框的上面，贴着顶边放不下时放到框下面
  const below = r ? r.top < 28 : false
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[2147483647]" data-element-picker="">
      {/* 抓取期间整页都是十字光标，提醒现在点下去不会触发按钮 */}
      <style>{'*{cursor:crosshair!important}'}</style>
      {r && (
        <>
          <div
            className="fixed rounded-[2px] border border-accent bg-accent/15"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          />
          <div
            className="fixed flex max-w-[min(28rem,calc(100vw-1rem))] items-center gap-1.5 truncate rounded-md bg-fg px-2 py-0.5 font-mono text-[0.71875rem] text-bg shadow-pop"
            style={{
              left: Math.max(4, Math.min(r.left, window.innerWidth - 200)),
              top: below ? Math.min(r.bottom + 4, window.innerHeight - 24) : r.top - 24,
            }}
          >
            <span className="font-semibold">{box.tag}</span>
            {box.name && <span className="opacity-80">{box.name}</span>}
            <span className="opacity-60 tabular-nums">
              {Math.round(r.width)} × {Math.round(r.height)}
            </span>
          </div>
        </>
      )}
      <div className="fixed top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line-strong bg-card px-3.5 py-1.5 text-[0.8125rem] text-fg shadow-pop">
        <SquareDashedMousePointer className="h-4 w-4 text-accent" />
        {t('点选页面上的元素，引用到对话')}
        <kbd className="rounded border border-line px-1 font-mono text-[0.6875rem] text-muted">Esc</kbd>
        <span className="text-muted">{t('退出抓取')}</span>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 输入框上的「抓取元素」按钮：只在设置里开了开发者模式时显示。
 * 点中元素后把引用文字交给 onPick（输入框放成一张引用卡片）
 */
export function ElementPickButton({ onPick, className }: { onPick: (text: string) => void; className?: string }) {
  const on = useData().settings?.developerMode
  const [active, setActive] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  // 关掉开发者模式时正在抓取的也一起退出
  if (!on && active) setActive(false)
  if (!on) return null
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setActive((v) => !v)}
        aria-pressed={active}
        aria-label={t('抓取界面元素')}
        title={t('抓取界面元素：点选页面上的元素引用到对话，Esc 退出')}
        className={cn(
          'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors',
          active ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-sel hover:text-fg',
          className,
        )}
      >
        <SquareDashedMousePointer className="h-4 w-4" />
      </button>
      {active && (
        <PickOverlay
          trigger={btn}
          onExit={() => setActive(false)}
          onPick={(el) => {
            setActive(false)
            onPick(formatElementRef(describeElement(el)))
          }}
        />
      )}
    </>
  )
}
