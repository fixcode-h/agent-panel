// 文件树里的文件和文件夹可以右键按住拖到输入框：松手时在输入框光标处插入它的引用。
// 不用 HTML5 的 draggable：右键按住拖动在浏览器和系统上触发得并不可靠，也拿不到「拖到了哪个输入框上」做高亮。
import { useEffect, useRef, useState, type RefObject } from 'react'
import { t } from '@shared/i18n'

/** 被拖动的内容：相对项目根目录的路径 */
export interface FileRef {
  path: string
  kind: 'file' | 'dir'
}

/** 移动超过这么多像素才算拖动：右键单击仍然正常弹菜单 */
const THRESHOLD = 4
/** 拖动结束后的一小段时间里也压掉右键菜单：Windows 上右键松手会补发一次 contextmenu */
const GUARD = 300

interface Target {
  el: HTMLElement
  drop: (item: FileRef) => void
}

/** 能接住拖入的输入框，最内层命中的那个接 */
let targets: Target[] = []
/** 现在光标停在哪个输入框上（高亮用） */
let hovered: HTMLElement | null = null
let dragging = false
let guardUntil = 0
let installed = false
const watchers = new Set<() => void>()
const notify = () => watchers.forEach((w) => w())

/**
 * 拖动中、或刚拖完时弹出的右键菜单不是用户点的，一律拦掉。
 * Radix 的右键菜单在 contextmenu 里打开，捕获阶段拦住就不用改各个菜单。
 */
function installGuard() {
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (!dragging && Date.now() > guardUntil) return
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
 * 开始一次右键拖动：鼠标移动超过阈值才进入拖动状态，
 * 经过某个输入框时把它标成高亮，松手交给它；没落在输入框上就什么也不做。
 */
export function startFileDrag(item: FileRef, from: { x: number; y: number }) {
  if (!installed) {
    installed = true
    installGuard()
  }
  let moving = false
  let view: ReturnType<typeof ghost> | null = null

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

  const move = (e: PointerEvent) => {
    if (!moving) {
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < THRESHOLD) return
      moving = true
      dragging = true
      view = ghost(item)
      document.body.append(view.box)
      document.documentElement.style.cursor = 'copy'
      document.body.style.userSelect = 'none'
      // 拖动起来以后菜单不该再跟着手指弹出来
      window.getSelection()?.removeAllRanges()
    }
    view!.box.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`
    over(e.clientX, e.clientY)
  }

  const finish = (e: PointerEvent | null) => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    if (moving) {
      dragging = false
      guardUntil = Date.now() + GUARD
      view?.box.remove()
      view = null
      document.documentElement.style.cursor = ''
      document.body.style.userSelect = ''
      hovered = null
      notify()
    }
    if (e && moving) hit(e.clientX, e.clientY)?.drop(item)
  }

  const up = (e: PointerEvent) => finish(e)
  const cancel = () => finish(null)

  // 捕获阶段接住：输入框、右键菜单自己也会监听这些事件
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
