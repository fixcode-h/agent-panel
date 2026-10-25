// 开发者模式的「元素抓取」：输入框上的按钮或快捷键进入抓取模式，像浏览器开发者工具的「选择元素」一样，
// 鼠标移到哪里就框住哪个元素，用设置里选的那个鼠标键（默认中键）点一下把它写成引用放进输入框并退出。
// 左键、右键在抓取期间照常可用（点按钮、弹菜单、拖线），Esc 或同一个快捷键退出；
// 抓到的引用投给开启抓取时正在用的那个输入框，没有输入框时写进剪贴板。
// 引用怎么写见 lib/element-ref.ts，源码位置来自构建时写进 DOM 的 data-src（scripts/lib/source-loc.mjs）
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { SquareDashedMousePointer } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useData, useNav } from '@/lib/data'
import {
  componentChain,
  parseLoc,
  pickStyles,
  wrapElementRef,
  type ElementInfo,
  type SourceLoc,
} from '@/lib/element-ref'
import {
  deliverPick,
  pickButtonLabel,
  pickText,
  pointerIntent,
  targetsComposer,
  targetsPickedInput,
} from '@/lib/element-pick'
import { hotkeyLabel, matchesHotkey, shouldTrigger } from '@/lib/hotkey'
import { DEFAULT_PICK_BUTTON, DEFAULT_PICK_HOTKEY, type PickButton } from '@shared/schema'
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

/**
 * 抓取期间吞掉的鼠标事件：不让页面上的按钮、菜单、拖动被触发。
 * 现在只拦抓取键（见 lib/element-pick.ts 的 pointerIntent）：左键、右键正常交给页面自己的交互
 */
const SWALLOW = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick'] as const

/**
 * 提示条自动淡出：指针进入提示条后延迟多久藏起来、离开后多久回来。
 * 进出都留一点延迟，鼠标从提示条上方擦过去（去点页面上的按钮）时不会闪一下
 */
const TIP_HIDE_DELAY_MS = 150
const TIP_SHOW_DELAY_MS = 100
/** 指针离提示条多近就算「在提示条上」，留一点容差，免得贴边时抖 */
const TIP_HIT_SLACK_PX = 2
/** 浮标和高亮框之间空出的距离：浮标放框上面时的间距、贴顶放不下改放框下面时贴着框内上沿的距离 */
const LABEL_OFFSET_PX = 24
const LABEL_INSET_PX = 4

/**
 * 判断指针在不在提示的位置上。不靠 pointerenter：提示条自己 pointer-events-none，
 * 让它可以吃指针事件的话，抓取期间「点按钮、拖线、点下面的元素」就都被它挡住了
 */
function isOnTip(x: number, y: number, el: Element | null) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return (
    x >= r.left - TIP_HIT_SLACK_PX &&
    x <= r.right + TIP_HIT_SLACK_PX &&
    y >= r.top - TIP_HIT_SLACK_PX &&
    y <= r.bottom + TIP_HIT_SLACK_PX
  )
}

/**
 * 指针停在提示上就把它淡出（它挡着下面要看的地方），移开再淡回来。
 * 只跟指针位置走：提示条本身一直是 pointer-events-none，点击照样穿透到下面的页面。
 * 提示条和浮标一起算（一次指针移动只判一遍、只挂一套监听）：它们同时在场，分开挂会重复跑 getBoundingClientRect
 */
function useTipFade(near: (x: number, y: number) => [boolean, boolean]) {
  const [faded, setFaded] = useState<[boolean, boolean]>([false, false])
  const nearRef = useRef(near)
  nearRef.current = near
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cur: [boolean, boolean] = [false, false]
    const at = (e: PointerEvent) => {
      const on = nearRef.current(e.clientX, e.clientY)
      if (on[0] === cur[0] && on[1] === cur[1]) return
      cur = on
      clearTimeout(timer)
      // 有任意一块要藏起来就用隐藏延迟，两块都离开才用显示延迟
      timer = setTimeout(() => setFaded(on), on[0] || on[1] ? TIP_HIDE_DELAY_MS : TIP_SHOW_DELAY_MS)
    }
    // 指针离开窗口时不会再有 pointermove：当成移开，回来时照常写回当前状态。
    // 必须判 relatedTarget：文档内从一个元素移到另一个元素时 mouseout 也会冒泡到 document，
    // 那不是「离开窗口」——当成移开会把刚起的隐藏计时器清掉，指针停着不动时就再也不淡出了
    const leave = (e: MouseEvent) => {
      if (e.relatedTarget) return
      cur = [false, false]
      clearTimeout(timer)
      setFaded([false, false])
    }
    window.addEventListener('pointermove', at, { capture: true })
    document.addEventListener('mouseout', leave)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', at, { capture: true })
      document.removeEventListener('mouseout', leave)
    }
  }, [])
  return faded
}

/**
 * 抓取模式的开 / 关。全局只一份：按钮进入抓取后按快捷键、或反过来，都不能出现两个覆盖层
 * （两套监听会把同一个中键吃两次）。接口和 useState 的用法一样，只在可写的地方调 setPick
 */
let pickActive = false
const activeListeners = new Set<() => void>()
const setPickActive = (on: boolean) => {
  if (pickActive === on) return
  pickActive = on
  activeListeners.forEach((f) => f())
}
const usePickActive = () =>
  useSyncExternalStore(
    (f) => {
      activeListeners.add(f)
      return () => activeListeners.delete(f)
    },
    () => pickActive,
    () => false,
  )

/**
 * 这一页上能接收引用的输入框。每个输入框上的「抓取元素」按钮登记自己，抓到的东西交给最近在用的那个：
 * 用快捷键开启抓取时没有「点的是哪个按钮」这个信息，只能靠焦点和最近一次聚焦 / 点选判断
 */
interface PickTarget {
  /** 放引用；返回 false 表示现在放不进去（例如附件在上传），交给剪贴板 */
  deliver: (text: string) => boolean
  /** 输入框所在的容器：用的时候再读 current（登记那一刻 ref 可能还没挂上） */
  root: RefObject<HTMLElement | null>
}

const pickTargets = new Set<PickTarget>()
let lastUsed: PickTarget | null = null

/**
 * 现在该往哪个输入框投：优先焦点所在的那个，其次最近聚焦过的；都没有时返回 undefined，
 * 让 deliverPick 走剪贴板。有多个输入框（父对话 + 右栏子对话）时不猜：猜错了会把引用插进另一个对话。
 * 只登记了一个输入框时直接用它，那是页面上唯一的去处。
 * 从某个输入框的按钮开启的抓取不用这里猜：目标就是那个输入框（见 takePick）
 */
function currentTarget(): PickTarget | undefined {
  const size = pickTargets.size
  if (size === 0) return undefined
  const focused = composerTarget()
  const recent = lastUsed && pickTargets.has(lastUsed) ? lastUsed : undefined
  // 多输入框时只在焦点相关才投，否则交给剪贴板（见 targetsComposer 的注释）
  if (!targetsComposer({ count: size, focused: !!focused, recent: !!recent })) return undefined
  return focused ?? recent ?? [...pickTargets][0]
}

/** 焦点所在的那个输入框（没有时 undefined） */
function composerTarget(): PickTarget | undefined {
  const active = document.activeElement
  return active ? [...pickTargets].find((t) => t.root.current?.contains(active)) : undefined
}

/** 焦点落在输入框里 */
const composerFocused = () => !!composerTarget()

/** 最近聚焦过某个输入框 */
const composerRecent = () => !!lastUsed && pickTargets.has(lastUsed)

/**
 * 这次抓取绑定的输入框：从哪个输入框的按钮进来的就投给哪个（快捷键进来的是 null，按焦点判）。
 * 全局只一份：抓取状态本身也是全局一份，两套「该投给谁」会分叉
 */
let pickedTarget: PickTarget | null = null
const setPick = (on: boolean, target: PickTarget | null = null) => {
  pickedTarget = on ? target : null
  setPickActive(on)
}

/**
 * 记住最近聚焦的那个输入框。挂在 document 上捕获：容器可能在登记之后才挂上（首次渲染、切到别的对话），
 * 在登记时现绑会漏掉；每次聚焦现查 contains，晚挂上也能认到。
 *
 * 必须全页一直挂着，不能按「页面上有没有输入框」开关：输入框会在页面切换中来去，
 * 按数量开关会正好在刚打开对话、还没聚焦时漏掉第一次聚焦，多输入框时又退回「投给渲染顺序第一个」
 */
function trackFocus() {
  const on = (e: Event) => {
    const el = e.target as Node | null
    for (const t of pickTargets) if (el && t.root.current?.contains(el)) lastUsed = t
  }
  document.addEventListener('focusin', on, true)
  return () => document.removeEventListener('focusin', on, true)
}

/**
 * 写进剪贴板：带标记包一层，粘回任何对话输入框都能还原成引用卡片；成功了提示用户自己粘。
 * 写不进去时把**完整**引用正文带在提示里（不只首行摘要）：只给摘要的话，用户照提示复制回去
 * 缺「- 元素：」那一行，粘回输入框也认不出是引用卡片，源码位置就丢了
 */
async function copyPick(text: string) {
  const full = wrapElementRef(text)
  try {
    await navigator.clipboard.writeText(full)
    toast.success(t('已复制到剪贴板，去输入框里粘贴'))
  } catch {
    toast.error(t('写不进剪贴板，请手动复制下面的引用'), {
      // 整段完整引用（带标记），点一下全选就能拷走；只给首行摘要的话粘回去认不出是引用卡片
      description: (
        <pre className="mt-1 max-h-48 cursor-text overflow-auto rounded bg-field p-2 font-mono text-[0.71875rem] whitespace-pre-wrap select-all">
          {full}
        </pre>
      ),
      duration: Infinity,
    })
    throw new Error('clipboard')
  }
}

function PickOverlay({
  trigger,
  button,
  hotkey,
  onPick,
  onExit,
}: {
  /** 进入抓取的那个按钮：抓取时再点它就是退出 */
  trigger: RefObject<HTMLElement | null>
  /** 抓取用的鼠标按键（设置 →「快捷键」里改） */
  button: PickButton
  /** 切换抓取模式的快捷键，提示条上显示 */
  hotkey: string
  onPick: (el: Element) => void
  onExit: () => void
}) {
  const [box, setBox] = useState<{ rect: DOMRect; tag: string; name: string } | null>(null)
  const target = useRef<Element | null>(null)
  const cb = useRef({ onPick, onExit })
  cb.current = { onPick, onExit }
  // 提示条、浮标都要能量出来位置：命中判定和浮标定位都靠它们自己的矩形
  const tipRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLDivElement | null>(null)
  // [提示条隐藏, 浮标隐藏]：两者各自按自己的矩形判定，一次指针移动只跑一遍
  const [tipHidden, labelHidden] = useTipFade((x, y) => [
    isOnTip(x, y, tipRef.current),
    isOnTip(x, y, labelRef.current),
  ])
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
    /**
     * 指针按下 / 松开：只有抓取键被吃掉，其他键原样交给页面。
     * 在捕获阶段拦，不然页面上的按钮已经先把事件处理掉了
     */
    const pointer = (e: Event) => {
      const p = e as PointerEvent
      const kind = pointerIntent(button, p.type === 'pointerdown' ? 'down' : 'up', p)
      if (kind === 'pass') return
      swallow(e)
      if (kind !== 'pick') return
      const el = at(p)
      // 点到发起抓取的那个按钮：当退出（和以前一样）
      if (!el || trigger.current?.contains(el)) return cb.current.onExit()
      cb.current.onPick(el)
    }
    /** 抓取键松开时浏览器还会补一个 click / auxclick（中键、右键）：一并吃掉，不然链接会在新标签打开 */
    const clickAway = (e: Event) => {
      if (pointerIntent(button, 'up', e as MouseEvent) === 'pass') return
      swallow(e)
    }
    // Esc 只退出抓取：在捕获阶段拦下，不让对话页的 Esc（停止对话、关弹窗）也收到
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        swallow(e)
        return cb.current.onExit()
      }
      // 同一个快捷键也能退出（和按钮切换的行为一致）；正在输入的地方还是让给输入框
      if (!matchesHotkey(e, hotkey) || !shouldTrigger(e, document.activeElement)) return
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
    window.addEventListener('keydown', key, opts)
    window.addEventListener('scroll', show, { capture: true, passive: true })
    window.addEventListener('resize', show)
    document.addEventListener('mouseout', leave)
    for (const n of SWALLOW)
      window.addEventListener(n, n === 'pointerdown' || n === 'pointerup' ? pointer : clickAway, opts)
    return () => {
      window.removeEventListener('pointermove', move, opts)
      window.removeEventListener('keydown', key, opts)
      window.removeEventListener('scroll', show, { capture: true })
      window.removeEventListener('resize', show)
      document.removeEventListener('mouseout', leave)
      for (const n of SWALLOW)
        window.removeEventListener(n, n === 'pointerdown' || n === 'pointerup' ? pointer : clickAway, opts)
    }
  }, [trigger, button, hotkey])

  const r = box?.rect
  // 标签放在框的上面，贴着顶边放不下时放到框下面
  const below = r ? r.top < 28 : false
  // 高亮框和提示条不吃鼠标事件，页面才点得到（抓取期间左键、右键要能正常用）
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[2147483647]" data-element-picker="">
      {r && (
        <>
          <div
            className="fixed rounded-[2px] border border-accent bg-accent/15"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          />
          <div
            ref={labelRef}
            data-pick-label=""
            // 浮标也挡视线：指针压到它就淡出，不然要点的元素正好被这块牌子盖住
            className={cn(
              'fixed flex max-w-[min(28rem,calc(100vw-1rem))] items-center gap-1.5 truncate rounded-md bg-fg px-2 py-0.5 font-mono text-[0.71875rem] text-bg shadow-pop transition-opacity',
              labelHidden && 'opacity-0',
            )}
            style={{
              left: Math.max(4, Math.min(r.left, window.innerWidth - 200)),
              top: below
                ? Math.min(r.bottom + LABEL_INSET_PX, window.innerHeight - LABEL_OFFSET_PX)
                : r.top - LABEL_OFFSET_PX,
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
      <div
        ref={tipRef}
        data-pick-tip=""
        // 淡出而不是挪走、卸载：留着位置就不跳动；也不让 Tab 停在它上面（整条都是纯文字）
        inert={tipHidden}
        className={cn(
          'fixed top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line-strong bg-card px-3.5 py-1.5 text-[0.8125rem] text-fg shadow-pop transition-opacity',
          tipHidden && 'opacity-0',
        )}
      >
        <SquareDashedMousePointer className="h-4 w-4 text-accent" />
        {t('{button}抓取元素，左键、右键照常可用', { button: pickButtonLabel(button) })}
        <kbd className="rounded border border-line px-1 font-mono text-[0.6875rem] text-muted">Esc</kbd>
        <span className="text-muted">{t('或')}</span>
        <kbd className="rounded border border-line px-1 font-mono text-[0.6875rem] text-muted">
          {hotkeyLabel(hotkey)}
        </kbd>
        <span className="text-muted">{t('退出抓取')}</span>
      </div>
    </div>,
    document.body,
  )
}

/** 快捷键开的抓取没有「点的是哪个按钮」，用一个稳定的空 ref */
const NO_TRIGGER: RefObject<HTMLElement | null> = { current: null }

/**
 * 这次抓取该投给哪个输入框：点某个输入框的按钮开启的，就是那个输入框（不管期间焦点跑到哪里）；
 * 快捷键开启的按焦点 / 最近聚焦，都没有时交给剪贴板。判定见 lib/element-pick.ts 的 targetsPickedInput
 */
async function takePick(el: Element, exit: () => void) {
  // exit 会清掉这次抓取绑定的目标，先取好
  const picked = pickedTarget
  exit()
  const alive = picked && pickTargets.has(picked) ? picked : null
  const target = targetsPickedInput({
    pinned: !!picked,
    pinnedAlive: !!alive,
    count: pickTargets.size,
    focused: composerFocused(),
    recent: composerRecent(),
  })
    ? (alive ?? currentTarget())
    : undefined
  lastUsed = target ?? null
  try {
    await deliverPick(pickText(describeElement(el)), {
      composer: target ? (text) => target.deliver(text) : undefined,
      clipboard: copyPick,
    })
  } catch {
    // copyPick 写不进剪贴板时已经提示过用户手动复制，这里不再弹一次
  }
}

export interface ElementPickButtonProps {
  /** 放引用（输入框放成一张引用卡片） */
  onPick: (text: string) => void
  className?: string
  /** 这个按钮所在的输入框容器：用快捷键开启抓取时靠它找出要投给哪个输入框 */
  rootRef?: RefObject<HTMLElement | null>
}

/**
 * 输入框上的「抓取元素」按钮：只在设置里开了开发者模式时显示。
 * 它只登记「这个输入框可以接收引用」和切换抓取开关，覆盖层由全局的 ElementPickHost 统一渲染（只一份）；
 * 关掉开发者模式时正在抓取的也一起退出
 */
export function ElementPickButton({ onPick, className, rootRef }: ElementPickButtonProps) {
  const settings = useData().settings
  const on = settings?.developerMode
  const hotkey = settings?.elementPicker.hotkey ?? DEFAULT_PICK_HOTKEY
  const button = settings?.elementPicker.button ?? DEFAULT_PICK_BUTTON
  const active = usePickActive()
  // 关掉开发者模式时正在抓取的也一起退出
  useEffect(() => {
    if (!on && active) setPick(false)
  }, [on, active])
  const pickCb = useRef(onPick)
  pickCb.current = onPick
  // 自己登记进全局的那一项：按钮点击时用它绑上「这次抓取投给这个输入框」
  const selfRef = useRef<PickTarget | null>(null)
  // 登记到全局：从按钮开启抓取时用它当投递目标，快捷键开启时靠它参与焦点判定
  useEffect(() => {
    if (!on) return
    const self: PickTarget = {
      // 输入框在就会收下（放一张引用卡片）；不在了（切换了页面、对话已关）由 deliverPick 退回剪贴板
      deliver: (text) => {
        pickCb.current(text)
        return true
      },
      root: rootRef ?? { current: null },
    }
    selfRef.current = self
    pickTargets.add(self)
    return () => {
      pickTargets.delete(self)
      if (selfRef.current === self) selfRef.current = null
      if (lastUsed === self) lastUsed = null
    }
    // rootRef 是稳定的 ref 对象，只跟着开发者模式的开关登记
  }, [on, rootRef])
  if (!on) return null

  return (
    <button
      type="button"
      // 从哪个输入框的按钮进来，抓到的引用就填回哪个输入框（见 takePick）
      onClick={() => (active ? setPick(false) : setPick(true, selfRef.current))}
      aria-pressed={active}
      aria-label={t('抓取界面元素')}
      title={t('抓取界面元素：{key} 开始或退出，{button}抓取页面上的元素，Esc 退出', {
        key: hotkeyLabel(hotkey),
        button: pickButtonLabel(button),
      })}
      className={cn(
        'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors',
        active ? 'bg-accent-soft text-accent' : 'text-subtle hover:bg-sel hover:text-fg',
        className,
      )}
    >
      <SquareDashedMousePointer className="h-4 w-4" />
    </button>
  )
}

/**
 * 抓取模式的宿主：快捷键监听 + 覆盖层。挂在应用根上，一个实例，
 * 按钮（输入框上的那个）只改它的开关，不再自己渲染覆盖层——同一个页面开着两套监听的话，
 * 同一个中键会被吃两次，抓取键也分不清该退出谁
 */
export function ElementPickHost() {
  const settings = useData().settings
  const on = settings?.developerMode
  const hotkey = settings?.elementPicker.hotkey ?? DEFAULT_PICK_HOTKEY
  const button = settings?.elementPicker.button ?? DEFAULT_PICK_BUTTON
  const active = usePickActive()
  // 快捷键不要求页面上有输入框：没有输入框的页面（首页、项目页、记忆库页）也能抓，
  // 抓到后没处放就走剪贴板，用户自己粘到要用的地方
  const listen = !!on
  // 关闭开发者模式时正在抓取的也一起退出
  useEffect(() => {
    if (!listen && active) setPick(false)
  }, [listen, active])
  // 换页面（路由变了）就退出抓取：抓取状态是全局单例，不在这个页面的高亮框上挂着，不退出的话
  // 下一页会带着「已经在抓取中」进来，再按快捷键就成了「退出」而不是「进入」，语义反过来
  const route = useNav().route
  useEffect(() => {
    setPick(false)
    // 只跟着页面走；同一页里的 id / sub 变化（切对话、切分节）不算换页
  }, [route.page])
  // 记住最近聚焦的输入框：有多个输入框时靠它区分该投给哪个
  useEffect(() => {
    if (!listen) return
    return trackFocus()
  }, [listen])
  useEffect(() => {
    if (!listen) return
    const key = (e: KeyboardEvent) => {
      // 抓取中时退出交给覆盖层（它还要区分 Esc）；这里只管进入。
      // 快捷键没有「点的是哪个按钮」，不绑目标：投给谁按焦点 / 最近聚焦判
      if (active || !matchesHotkey(e, hotkey) || !shouldTrigger(e, document.activeElement)) return
      e.preventDefault()
      e.stopPropagation()
      setPick(true)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [listen, active, hotkey])
  if (!listen || !active) return null
  return (
    <PickOverlay
      trigger={NO_TRIGGER}
      button={button}
      hotkey={hotkey}
      onExit={() => setPick(false)}
      onPick={(el) => void takePick(el, () => setPick(false))}
    />
  )
}
