import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { t } from '@shared/i18n'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { activeIndex, atBottom, jumpTop, sortByDocument } from '@/lib/section-nav'

/**
 * 设置页右侧内容区的「本页小节」菜单：一节里的 Group 自己声明小节标题，这里收集起来做成一条吸顶的小 tab，
 * 点一下跳到那个小节、滚动时高亮当前所在的。
 * 和左栏的一级导航区分开：这里是页内锚点，字号更小、没有图标、只有一条细细的高亮线。
 *
 * 状态放在模块里而不是套一层 Provider：设置弹窗同时只有一个实例，套 Provider 会把整列内容的缩进重排一遍，
 * 看不出真正的改动。谁进谁出都按挂载 / 卸载注册，关掉弹窗后列表自然空掉。
 * 哪一节算「当前」、跳到哪里这些判定在 `web/src/lib/section-nav.ts`（纯函数，有单测）。
 */

interface Entry {
  id: string
  label: string
  el: HTMLElement
}

interface Snapshot {
  items: { id: string; label: string }[]
  active: string
}

const EMPTY: Snapshot = { items: [], active: '' }

let entries: Entry[] = []
let container: HTMLDivElement | null = null
let snapshot: Snapshot = EMPTY
const listeners = new Set<() => void>()

/**
 * 按页面里的实际顺序排（判定在 `web/src/lib/section-nav.ts` 的 `sortByDocument`，有单测）。
 * 不能信登记顺序：条件渲染的组重新挂载、`label` 变化都会把登记 append 到末尾，和页面顺序对不上。
 */
function ordered() {
  return sortByDocument(entries)
}

function build(): Snapshot {
  return { items: ordered().map(({ id, label }) => ({ id, label })), active: snapshot.active }
}

function emit() {
  snapshot = build()
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** getSnapshot 必须是固定引用：每次现写一个箭头函数会让 React 每次都重渲染 */
const getSnapshot = () => snapshot

/** 只改「当前是哪个小节」：值没变就不通知订阅者（滚动事件很密） */
function setActive(id: string) {
  if (id === snapshot.active) return
  snapshot = { ...snapshot, active: id }
  for (const l of listeners) l()
}

/**
 * 当前在哪个小节：按各小节顶部相对容器视口顶部的距离算，滚到底时算最后一个。
 */
function refresh() {
  if (!container || !entries.length) return
  const top = container.getBoundingClientRect().top
  const list = ordered()
  const tops = list.map((e) => e.el.getBoundingClientRect().top - top)
  const i = activeIndex(tops, atBottom(container))
  if (i >= 0) setActive(list[i].id)
}

function go(id: string) {
  const e = entries.find((x) => x.id === id)
  if (!e || !container) return
  const offset = e.el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  container.scrollTo({ top: jumpTop(offset), behavior: 'smooth' })
  // 平滑滚动要一会儿才到，先按点击的那个点亮，别等滚动事件
  setActive(id)
}

/**
 * 搜索结果点进来后定位到那一项：滚到它所在的位置（放在视口上方三分之一处，上下文都看得到），再闪一下底色。
 * 刚切页时那一项可能还没挂载（CLI 页要等数据），每帧找一次，最多等一秒；找不到就停在页顶。
 */
export function revealSetting(selectors: string[]) {
  let tries = 0
  const step = () => {
    const el = container && selectors.map((s) => container!.querySelector<HTMLElement>(s)).find(Boolean)
    if (!el || !container) {
      if (++tries < 60) requestAnimationFrame(step)
      return
    }
    const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    container.scrollTo({ top: Math.max(0, offset - container.clientHeight / 3), behavior: 'smooth' })
    // 先摘掉再加回去：连着点同一项时动画能从头再放一次
    el.removeAttribute('data-setting-flash')
    void el.offsetWidth
    el.setAttribute('data-setting-flash', '')
    setTimeout(() => el.removeAttribute('data-setting-flash'), 2000)
  }
  requestAnimationFrame(step)
}

/** 内容区的滚动容器挂这个回调 ref：跳转和「当前小节」都按它的滚动算 */
export function setSectionScroll(el: HTMLDivElement | null) {
  if (container) {
    container.removeEventListener('scroll', refresh)
    window.removeEventListener('resize', refresh)
  }
  container = el
  if (el) {
    el.addEventListener('scroll', refresh, { passive: true })
    window.addEventListener('resize', refresh)
  }
  refresh()
}

let seed = 0

/**
 * Group 用它声明自己是「本页的一个小节」：有 title 才有锚点。
 * 返回的 id 给 section 当锚点（滚动定位、`aria-labelledby` 一类要用），ref 给 section 挂载后登记位置。
 */
export function useSectionAnchor(label?: string) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const idRef = useRef('')
  if (!idRef.current) idRef.current = `settings-sec-${++seed}`

  useEffect(() => {
    if (!el || !label) return
    const entry: Entry = { id: idRef.current, label, el }
    entries = [...entries, entry]
    emit()
    refresh()
    return () => {
      entries = entries.filter((x) => x !== entry)
      emit()
    }
  }, [el, label])

  return { id: idRef.current, ref: setEl }
}

/** 本页小节菜单：只有两个以上小节才显示，一个小节时没必要多一条横栏 */
export function SectionToc() {
  const { items, active } = useSyncExternalStore(subscribe, getSnapshot)
  if (items.length < 2) return null
  // 刚打开、还没滚动也没算过时没有当前项：先点亮第一个，别出现整条都暗的情况
  const cur = active || items[0].id
  return (
    <TabBar variant="underline" label={t('本页小节')} className="px-5 md:px-9">
      {items.map((s) => (
        <TabItem key={s.id} active={cur === s.id} onSelect={() => go(s.id)}>
          {s.label}
        </TabItem>
      ))}
    </TabBar>
  )
}
