// 文件树里的文件和文件夹可以左键长按后拖到输入框：松手时在输入框光标处插入它的引用。
// 不用 HTML5 的 draggable：dragstart 由浏览器接管，拖到哪个输入框、预览长什么样都得跟着它，
// 也拿不到「拖到了哪个输入框上」做高亮。右键留给右键菜单，所以用长按作为拖动的手势。
import { useEffect, useRef, useState, type RefObject } from 'react'
import { t } from '@shared/i18n'

/** 被拖动的内容：相对项目根目录的路径 */
export interface FileRef {
  path: string
  kind: 'file' | 'dir'
}

/** 左键按住这么久才开始拖：短按仍然是单击（打开文件、展开目录） */
export const LONG_PRESS_MS = 300
/**
 * 长按是否已经够久。抽成纯函数单独测：定时器到点和指针移动都按这一个判断，
 * 免得两处阈值写得不一样（拖起来太灵或太迟钝）。
 */
export const longPressed = (elapsed: number) => elapsed >= LONG_PRESS_MS
/**
 * 拖动结束后的一小段时间里压掉浏览器补发的那次 click：长按起点和松手都还在文件行上时，
 * 浏览器照样会认定这是一次单击并打开文件。
 */
const CLICK_GUARD = 200

interface Target {
  el: HTMLElement
  drop: (item: FileRef) => void
}

/** 能接住拖入的输入框，最内层命中的那个接 */
let targets: Target[] = []
/** 现在光标停在哪个输入框上（高亮用） */
let hovered: HTMLElement | null = null
let installed = false
/** 拖动刚结束到用户下一次真正点击之间，补发的那次 click 要拦掉 */
let clickUntil = 0
const watchers = new Set<() => void>()
const notify = () => watchers.forEach((w) => w())

/**
 * 拖动松手后浏览器还会补一次 click（按下和松开落在同一个元素上时），
 * 捕获阶段压掉这一次：否则长按拖动会顺带把文件打开，或者把输入框里的光标挪到指针位置。
 */
function installClickGuard() {
  window.addEventListener(
    'click',
    (e) => {
      if (Date.now() > clickUntil) return
      clickUntil = 0
      e.preventDefault()
      e.stopPropagation()
    },
    true,
  )
}

/** 注册一个能接住拖入的输入框；返回注销函数 */
export function registerFileDrop(el: HTMLElement, drop: (item: FileRef) => void) {
  const target = { el, drop }
  targets = [...targets, target]
  return () => {
    targets = targets.filter((x) => x !== target)
    if (hovered === el) {
      hovered = null
      notify()
    }
  }
}

/** 拖到输入框上的内容：和输入 @ 一样是「@相对路径 」，Agent 在项目目录里看到路径就能自己读 */
export function insertFileRef(
  editor: { text(): string; caret(): number; insert(text: string): void; focus(): void },
  item: FileRef,
) {
  const pos = editor.caret()
  const before = editor.text().slice(0, pos)
  const ref = `@${item.kind === 'dir' ? `${item.path}/` : item.path} `
  editor.insert(pos > 0 && !/\s$/.test(before) ? ` ${ref}` : ref)
  editor.focus()
}

/** 跟着光标的拖动预览：文件名 + 能不能松手的提示 */
function ghost(item: FileRef) {
  const box = document.createElement('div')
  box.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:2147483000',
    'pointer-events:none',
    'display:flex',
    'flex-direction:column',
    'gap:2px',
    'max-width:340px',
    'padding:6px 10px',
    'border-radius:10px',
    'border:1px solid var(--color-line-strong)',
    'background:var(--color-card)',
    'box-shadow:0 12px 32px -10px rgb(0 0 0 / 0.45)',
    'opacity:0.96',
  ].join(';')
  const name = item.path.slice(item.path.lastIndexOf('/') + 1) || item.path
  const title = document.createElement('span')
  title.textContent = item.kind === 'dir' ? `${name}/` : name
  title.style.cssText = [
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap',
    'font-family:var(--font-mono)',
    'font-size:12px',
    'color:var(--color-fg)',
  ].join(';')
  const hint = document.createElement('span')
  hint.textContent = t('拖到输入框上，松开插入引用')
  hint.style.cssText = 'font-size:11px;color:var(--color-subtle)'
  box.append(title, hint)
  return { box, hint }
}

/**
 * 开始一次拖动：左键按住够 LONG_PRESS_MS 才进入拖动状态，
 * 经过某个输入框时把它标成高亮，松手交给它；没落在输入框上就什么也不做。
 * 右键在菜单里，这里只认左键（触摸、笔的按下也是 0）。
 */
export function startFileDrag(item: FileRef, press: { clientX: number; clientY: number; button: number }) {
  if (press.button !== 0) return
  if (!installed) {
    installed = true
    installClickGuard()
  }
  const from = { x: press.clientX, y: press.clientY }
  /** 指针最后停在的位置：长按到点时 ghost 按它画，按住不动也能看到能拖 */
  let at = from
  let moving = false
  /** 长按之后真的动过：按住不动就松手算取消，不插引用 */
  let wandered = false
  let view: ReturnType<typeof ghost> | null = null
  const startedAt = Date.now()
  // 按住期间禁掉文本选择：长按不能被当成拖选文件名；松手时不管拖没拖起来都恢复
  document.body.style.userSelect = 'none'

  // 命中取面积最小的那个：外层容器里套输入框时落在最里层
  const hit = (x: number, y: number) =>
    targets.reduce<Target | undefined>((best, target) => {
      const r = target.el.getBoundingClientRect()
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return best
      if (!best) return target
      const b = best.el.getBoundingClientRect()
      return r.width * r.height < b.width * b.height ? target : best
    }, undefined)

  const over = (x: number, y: number) => {
    const next = hit(x, y)?.el ?? null
    if (next === hovered) return
    hovered = next
    notify()
    if (view) view.hint.textContent = next ? t('松开鼠标，插入引用') : t('拖到输入框上，松开插入引用')
    if (view) view.hint.style.color = next ? 'var(--color-accent)' : 'var(--color-subtle)'
  }

  const follow = () => {
    if (!view) return
    view.box.style.transform = `translate(${at.x + 12}px, ${at.y + 12}px)`
    over(at.x, at.y)
  }

  const begin = () => {
    if (moving) return
    moving = true
    view = ghost(item)
    document.body.append(view.box)
    document.documentElement.style.cursor = 'copy'
    // 长按前页面上可能已经选了一段文字，拖起来时清掉
    window.getSelection()?.removeAllRanges()
    follow()
  }

  const move = (e: PointerEvent) => {
    at = { x: e.clientX, y: e.clientY }
    if (!moving) {
      // 时间没到之前移动只是等：把「移动超过阈值」当拖动的话，快速划过页面也会拖出引用
      if (!longPressed(Date.now() - startedAt)) return
      begin()
    }
    wandered = true
    follow()
  }

  const finish = (e: PointerEvent | null) => {
    window.clearTimeout(hold)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    document.body.style.userSelect = ''
    if (moving) {
      clickUntil = Date.now() + CLICK_GUARD
      view?.box.remove()
      view = null
      document.documentElement.style.cursor = ''
      hovered = null
      notify()
    }
    if (e && wandered) hit(e.clientX, e.clientY)?.drop(item)
  }

  const up = (e: PointerEvent) => finish(e)
  const cancel = () => finish(null)
  // 按住不动也会进入拖动：到点就亮出 ghost，告诉用户可以拖了
  const hold = window.setTimeout(() => {
    if (longPressed(Date.now() - startedAt)) begin()
  }, LONG_PRESS_MS)

  // 捕获阶段接住：输入框自己也会监听这些事件
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
}

/** 把一个元素变成能接住文件引用的输入框；返回现在有没有拖到它上面 */
export function useFileRefDrop(el: RefObject<HTMLElement | null>, onDrop: (item: FileRef) => void) {
  const [over, setOver] = useState(false)
  // onDrop 每次渲染都是新的，放进依赖会让注册反复重建；只保留最新的引用
  const cb = useRef(onDrop)
  cb.current = onDrop
  useEffect(() => {
    const node = el.current
    if (!node) return
    const off = registerFileDrop(node, (item) => cb.current(item))
    const watch = () => setOver(hovered === node)
    watchers.add(watch)
    watch()
    return () => {
      off()
      watchers.delete(watch)
    }
  }, [el])
  return over
}
