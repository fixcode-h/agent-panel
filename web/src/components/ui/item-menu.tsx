import { Copy, Play, Trash2, type LucideIcon } from 'lucide-react'
import { filterItems, isAction, isPick, isSub, MenuRows, MenuSearch, SUB_SEARCH_AT, tidy } from './item-menu-rows'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { copyText as copy } from '@/lib/copy-text'

/**
 * 按项目列表打开的菜单（右键菜单、按钮下拉）：调 openMenu(e, items) 就开，不用在每处写一套 Radix 的触发器和内容。
 * 最早是 UE 插件给性能页做的（用户 2026-11-11：各个部位都要有右键菜单，照 Unreal Insights），带子菜单和菜单内搜索；
 * 2026-11-23 收回面板共用（「可统一能力盘点」第 3 项），开放给插件。圆角、底色、边框跟设置 →「组件」里「菜单」的调节项走。
 * 一页只有一个菜单：面板在整个应用里挂了一个 MenuHost（App.tsx），页面不用自己挂（以前 GM 页漏挂过，右键没反应）；画到 body 上
 * （挂在 body 上不被分栏的 overflow 裁掉，也不受父级动画的 transform 影响定位）。
 * 打开时从鼠标处淡入放大；点外面、Esc、滚动、窗口失焦都关；上下键选、回车执行。
 */
export interface MenuAction {
  label: string
  icon?: LucideIcon
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  /** 右侧的快捷键 / 说明 */
  hint?: string
  /** 打勾（开关类的菜单项） */
  checked?: boolean
  /** 名字前面的小标记（「最近看过」里的实例 / 资源徽标） */
  lead?: ReactNode
  /** 淡显（还能点，例如换了世界、对象可能已经不在的历史记录） */
  dim?: boolean
}

/** 子菜单里能放的项（子菜单不再套子菜单） */
export type MenuLeaf = MenuAction | { title: string } | 'sep'

/**
 * 子菜单（「移到模块 ▸」）：长列表（模块、分组、宏……）不平铺在主菜单里——用户 2026-11-23：
 * 几十个模块平铺，菜单占满一屏、遮住树、下面的「删除」都看不到。悬停或点它在旁边展开，
 * 超过 SUB_SEARCH_AT 项自动带搜索框，限高可滚
 */
export interface MenuSub {
  label: string
  icon?: LucideIcon
  /** 右侧的说明（例如现在在哪个模块） */
  hint?: string
  disabled?: boolean
  sub: (MenuLeaf | false | '' | undefined | null)[]
  /** 项多到带搜索框时，框里的提示字（默认「搜索…」） */
  search?: string
}

export type MenuItem = MenuLeaf | MenuSub

interface State {
  x: number
  y: number
  items: MenuItem[]
  seq: number
  /** 带搜索框（流程图上的节点菜单）：框里的提示字 */
  search?: string
  onClose?: () => void
}

export interface MenuOptions {
  /** 顶上放一个搜索框，按名字和右边的说明筛（项多的菜单：蓝图画布上的「加节点」） */
  search?: string
  /** 菜单关掉时调（选了项、点外面、Esc、被新菜单顶掉都算）：蓝图画布拖线弹菜单时靠它收掉临时那根线 */
  onClose?: () => void
}

let state: State | undefined
let seq = 0
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

/** 在鼠标位置打开菜单；空菜单不开。会拦掉浏览器自己的右键菜单 */
export function openMenu(
  e: MouseEvent | globalThis.MouseEvent,
  items: (MenuItem | false | '' | undefined | null)[],
  o: MenuOptions = {},
) {
  e.preventDefault()
  e.stopPropagation()
  const list = tidy(items)
  if (!list.length) {
    o.onClose?.()
    return
  }
  const old = state
  state = { x: e.clientX, y: e.clientY, items: list, seq: ++seq, search: o.search, onClose: o.onClose }
  old?.onClose?.()
  emit()
}

/** 挂在按钮下面打开（下拉菜单：导航条的「最近看过」、分类栏的「更多」），不是右键 */
export function openMenuAt(el: HTMLElement, items: (MenuItem | false | '' | undefined | null)[], o?: MenuOptions) {
  const r = el.getBoundingClientRect()
  openMenu(
    { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent,
    items,
    o,
  )
}

export function closeMenu() {
  if (!state) return
  const old = state
  state = undefined
  emit()
  old.onClose?.()
}

/** 复制到剪贴板并提示（菜单里「复制…」都走这里）：走面板的 copyText（剪贴板接口不可用时有兜底） */
export function copyText(text: string) {
  void copy(text, { done: t('已复制'), fail: t('复制失败：浏览器不让写剪贴板') })
}

/**
 * 整页兜底的右键（GameTest 页，用户 2026-11-18：整页都用自己的菜单，不弹浏览器的）：行、空白处各有菜单的会先拦下，
 * 冒泡到这里的是其余地方——选中了文字给「复制」，输入框里留浏览器自己的（要粘贴、拼写建议），其余什么也不弹
 */
export function pageMenu(e: MouseEvent | globalThis.MouseEvent) {
  const el = e.target as HTMLElement | null
  if (el?.closest('input, textarea, [contenteditable="true"]')) return
  const text = window.getSelection()?.toString() ?? ''
  if (text.trim()) openMenu(e, [{ label: t('复制'), icon: Copy, onClick: () => copyText(text) }])
  else e.preventDefault()
}

/** 挂着的 MenuHost：同一页里可能挂了好几个（性能页、检视区、分类栏、设置里的示例），只让最早挂上的那个画，免得一个菜单画两份 */
const hosts: string[] = []

export function MenuHost() {
  const id = useId()
  useLayoutEffect(() => {
    hosts.push(id)
    emit()
    return () => {
      hosts.splice(hosts.indexOf(id), 1)
      emit()
    }
  }, [id])
  const cur = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )
  const first = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => hosts[0] === id,
  )
  if (!cur || !first) return null
  return createPortal(<Menu key={cur.seq} s={cur} />, document.body)
}

/** 子菜单紧贴主菜单的哪一边、多高：按那一行的位置算，放不下就翻到左边，上下夹在窗口里 */
interface SubPos {
  left: number
  top: number
  ox: 'left' | 'right'
}
const EDGE = 8
/** 悬停多久展开 / 收起子菜单：鼠标斜着划向子菜单时会擦过别的行，不能一擦就收 */
const HOVER_MS = 150

/** inline：设置 →「组件」里的示例，原地画一份不响应外部点击的菜单 */
function Menu({ s, inline }: { s: State; inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: s.x, top: s.y, ox: 'left', oy: 'top' })
  const [q, setQ] = useState('')
  const items = s.search === undefined ? s.items : filterItems(s.items, q)
  const [act, setAct] = useState(-1)
  // 子菜单：开着第几项、键盘在哪一列、子菜单里选中哪项、搜索字
  const [open, setOpen] = useState(-1)
  const [inSub, setInSub] = useState(false)
  const [subAct, setSubAct] = useState(-1)
  const [subQ, setSubQ] = useState('')
  const [subPos, setSubPos] = useState<SubPos>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const subInput = useRef<HTMLInputElement>(null)
  const subItem = open >= 0 ? items[open] : undefined
  const sub = subItem && isSub(subItem) ? subItem : undefined
  const subAll = sub ? tidy(sub.sub) : []
  const subSearch = sub && subAll.filter(isAction).length > SUB_SEARCH_AT ? (sub.search ?? t('搜索…')) : undefined
  const subItems = subSearch === undefined ? subAll : filterItems(subAll, subQ)

  // 搜索时默认选中第一项：打几个字直接回车
  useEffect(() => {
    if (s.search !== undefined) setAct(items.findIndex(isPick))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 只在关键字变时重选，items 每次渲染都是新数组
  }, [q])
  useEffect(() => {
    if (subSearch !== undefined && subQ) setSubAct(subItems.findIndex(isAction))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 同上，只在子菜单的关键字变时重选
  }, [subQ])
  useEffect(() => () => clearTimeout(timer.current), [])
  // 键盘上下选到看不见的项（长菜单在里面滚）时滚过去
  useEffect(() => {
    ref.current?.querySelector(`[data-menu-row="${act}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [act])
  useEffect(() => {
    if (inSub) subRef.current?.querySelector(`[data-menu-row="${subAct}"]`)?.scrollIntoView({ block: 'nearest' })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 鼠标悬停也会改 subAct，那时项本来就看得见，滚不滚都一样
  }, [subAct])

  // 贴着屏幕边时往左 / 往上翻，动画的原点跟着换；比窗口还高时贴顶，里面滚（菜单本身限高）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || inline) return
    // 用 offset 尺寸：淡入动画的 scale 会让 getBoundingClientRect 量小，算出来的位置偏下、超出窗口
    const r = { width: el.offsetWidth, height: el.offsetHeight }
    const flipX = s.x + r.width > innerWidth - EDGE
    const flipY = s.y + r.height > innerHeight - EDGE
    const up = s.y - r.height
    setPos({
      left: flipX ? Math.max(EDGE, s.x - r.width) : s.x,
      top: !flipY ? s.y : up >= EDGE ? up : Math.max(EDGE, innerHeight - EDGE - r.height),
      ox: flipX ? 'right' : 'left',
      oy: flipY ? 'bottom' : 'top',
    })
  }, [s])

  // 子菜单贴着那一行的右边展开，右边放不下翻到主菜单左边；上下夹在窗口里
  useLayoutEffect(() => {
    const el = subRef.current
    const row = ref.current?.querySelector<HTMLElement>(`[data-menu-row="${open}"]`)
    const box = ref.current?.getBoundingClientRect()
    if (!el || !row || !box) return setSubPos(undefined)
    const rr = row.getBoundingClientRect()
    const r = { width: el.offsetWidth, height: el.offsetHeight }
    // 主菜单的左右边按它定下的位置和真实宽度算（同上，动画中量到的是缩放后的）
    const left = pos.left
    const right0 = pos.left + (ref.current?.offsetWidth ?? box.width)
    const right = right0 + 2 + r.width <= innerWidth - EDGE
    setSubPos({
      left: right ? right0 + 2 : Math.max(EDGE, left - 2 - r.width),
      top: Math.max(EDGE, Math.min(rr.top - 5, innerHeight - EDGE - r.height)),
      ox: right ? 'left' : 'right',
    })
  }, [open, pos, subItems.length])

  // 长子菜单定好位置、显示出来后把光标放进它的搜索框：直接打字就能筛（悬停展开的也一样）
  useEffect(() => {
    if (subPos) subInput.current?.focus()
    // 只在换了子菜单、或刚定好位置时聚焦；位置随筛选微调时不用再聚焦
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!subPos])

  const openSub = (i: number, focus: boolean) => {
    clearTimeout(timer.current)
    if (i !== open) {
      setSubQ('')
      setSubAct(-1)
    }
    setOpen(i)
    setInSub(focus)
    if (focus) {
      const it = items[i]
      if (it && isSub(it)) setSubAct(tidy(it.sub).findIndex(isAction))
    }
  }
  const closeSub = () => {
    clearTimeout(timer.current)
    setOpen(-1)
    setInSub(false)
  }
  const pick = (it: MenuAction) => {
    closeMenu()
    it.onClick()
  }
  // 悬停：停在子菜单那一行上一会儿就展开，停到别的行上一会儿就收起（鼠标进了子菜单就取消）
  const hover = (i: number) => {
    setAct(i)
    setInSub(false)
    clearTimeout(timer.current)
    const it = items[i]
    if (it && isSub(it) && isPick(it)) {
      if (i !== open) timer.current = setTimeout(() => openSub(i, false), open < 0 ? 0 : HOVER_MS)
    } else if (open >= 0) timer.current = setTimeout(closeSub, HOVER_MS)
  }

  useEffect(() => {
    if (inline) return
    const inside = (e: Event) =>
      e.target instanceof Node && !!(ref.current?.contains(e.target) || subRef.current?.contains(e.target))
    const away = (e: Event) => {
      if (!inside(e)) closeMenu()
    }
    const move = (list: MenuItem[], cur: number, down: boolean, ok: (x: MenuItem) => boolean) => {
      const idx = list.map((x, i) => (ok(x) ? i : -1)).filter((i) => i >= 0)
      if (!idx.length) return cur
      const at = idx.indexOf(cur)
      if (at < 0) return down ? idx[0] : idx[idx.length - 1]
      return idx[down ? (at + 1) % idx.length : (at - 1 + idx.length) % idx.length]
    }
    const key = (e: KeyboardEvent) => {
      const vert = e.key === 'ArrowDown' || e.key === 'ArrowUp'
      if (open >= 0 && inSub) {
        // 键盘在子菜单里：Esc / ← 只收子菜单，回到主菜单那一行
        if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !subQ)) {
          e.preventDefault()
          setAct(open)
          return closeSub()
        }
        if (vert) {
          e.preventDefault()
          setSubAct(move(subItems, subAct, e.key === 'ArrowDown', isAction))
        } else if (e.key === 'Enter' && subAct >= 0) {
          e.preventDefault()
          const it = subItems[subAct]
          if (it && isAction(it)) pick(it)
        }
        return
      }
      if (e.key === 'Escape') return closeMenu()
      if (vert) {
        e.preventDefault()
        if (open >= 0) closeSub()
        setAct(move(items, act, e.key === 'ArrowDown', isPick))
      } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && act >= 0) {
        const it = items[act]
        if (it && isSub(it) && isPick(it)) {
          e.preventDefault()
          openSub(act, true)
        } else if (e.key === 'Enter' && it && isAction(it)) {
          e.preventDefault()
          pick(it)
        }
      }
    }
    addEventListener('pointerdown', away, true)
    addEventListener('contextmenu', away, true)
    addEventListener('keydown', key)
    addEventListener('blur', closeMenu)
    addEventListener('resize', closeMenu)
    // 菜单里面滚（带搜索的长菜单、子菜单）不关
    addEventListener('wheel', away, { passive: true })
    return () => {
      removeEventListener('pointerdown', away, true)
      removeEventListener('contextmenu', away, true)
      removeEventListener('keydown', key)
      removeEventListener('blur', closeMenu)
      removeEventListener('resize', closeMenu)
      removeEventListener('wheel', away)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- openSub / closeSub / pick 每次渲染新建，读的都是这里列出的状态
  }, [s, act, inline, items, open, inSub, subAct, subItems, subQ])

  const box = cn(
    'flex flex-col min-w-48 max-w-80 rounded-(--c-menu-radius) border-(length:--c-menu-border) border-pop-edge bg-(--c-menu-bg) p-1 text-footnote shadow-pop motion-safe:animate-pop',
  )
  // 不论有没有搜索框都限高：再长的菜单也不超出窗口，里面滚
  const maxH = inline ? undefined : `calc(100vh - ${EDGE * 2}px)`
  return (
    <>
      <div
        ref={ref}
        role="menu"
        // 弹出的那个（设置里的示例是画在页里的同一个组件）：蓝图画布拖线弹菜单时按它找菜单摆在哪
        data-floating={inline ? undefined : ''}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(inline ? 'relative' : 'fixed z-[1000]', box)}
        style={
          inline ? undefined : { left: pos.left, top: pos.top, maxHeight: maxH, transformOrigin: `${pos.oy} ${pos.ox}` }
        }
      >
        {s.search !== undefined && <MenuSearch value={q} placeholder={s.search} onChange={setQ} />}
        <div
          className={cn(
            // 列表本身不能是 flex 列：小标题、分隔线没有 shrink-0，限高时会被压扁（0.55.6 的回归，GameTest 画布「找节点」）
            'min-h-0 overflow-y-auto',
            s.search !== undefined && 'max-h-[min(420px,60vh)]',
          )}
        >
          <MenuRows items={items} act={act} open={open} onHover={hover} onPick={pick} onSub={(i) => openSub(i, true)} />
        </div>
      </div>
      {sub && !inline && (
        <div
          ref={subRef}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
          // 鼠标进了子菜单：取消「停到别的行上要收起」的计时
          onPointerEnter={() => {
            clearTimeout(timer.current)
            setAct(open)
          }}
          className={cn('fixed z-[1001]', box, !subPos && 'invisible')}
          style={{
            left: subPos?.left ?? 0,
            top: subPos?.top ?? 0,
            maxHeight: `min(440px, ${maxH})`,
            transformOrigin: `top ${subPos?.ox ?? 'left'}`,
          }}
        >
          {subSearch !== undefined && (
            <MenuSearch
              ref={subInput}
              value={subQ}
              placeholder={subSearch}
              onChange={(v) => {
                setSubQ(v)
                setInSub(true)
              }}
            />
          )}
          <div className="min-h-0 overflow-y-auto">
            <MenuRows
              items={subItems}
              act={inSub ? subAct : -1}
              onHover={(i) => {
                setInSub(true)
                setSubAct(i)
              }}
              onPick={pick}
            />
          </div>
        </div>
      )}
    </>
  )
}

/** 设置 →「组件」里的示例：原地一份菜单看样子，下面一块区域点右键弹真的 */
export function MenuSpecimen() {
  const items: MenuItem[] = [
    { title: t('新录制') },
    { label: t('运行'), icon: Play, onClick: () => undefined, hint: 'Enter' },
    { label: t('复制路径'), icon: Copy, onClick: () => undefined },
    'sep',
    { label: t('删除'), icon: Trash2, danger: true, onClick: () => undefined },
  ]
  return (
    <div className="flex w-full flex-wrap items-start gap-4">
      <Menu s={{ x: 0, y: 0, items, seq: 0 }} inline />
      <div
        onContextMenu={(e) => openMenu(e, items)}
        className="flex h-32 min-w-48 flex-1 items-center justify-center rounded-lg border border-dashed border-line-strong text-footnote text-subtle"
      >
        {t('在这里点右键')}
      </div>
    </div>
  )
}
