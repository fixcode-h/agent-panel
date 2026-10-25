import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { DEFAULT_INSET, GAP, clampPos, loadPos, movedEnough, savePos, type Pos } from '@/lib/minimized-chat'

/** 浮条高度（h-11）：默认位置的槽位间距也按它算 */
const DOCK_H = 44
/** 拖动刚结束后浏览器可能补发一次 click，这串时间去重 */
const CLICK_GUARD = 500

/** 浮条上的状态：两个窗口共用同一套文字，看起来才是同一个东西 */
export type ChatDockState = 'running' | 'done' | 'ended' | 'gone' | 'idle'

const stateText = (s: ChatDockState) =>
  s === 'running'
    ? t('进行中…')
    : s === 'done'
      ? t('已完成')
      : s === 'ended'
        ? t('已结束')
        : s === 'gone'
          ? t('对话已关闭')
          : ''

/**
 * 最小化后的浮条：「AI 处理」和「AI 优化」两个窗口都用它，形状、层级、动效、状态文字保持一致。
 *
 * - 可以拖到任意位置，松手后夹回视口内并记进 localStorage（按 id 分开记，两个窗口互不影响）
 * - 拖动用 pointer 事件 + 指针捕获，不用 HTML5 draggable：那样拖不出窗口外、也拿不到稳定的坐标
 * - 移动没超过阈值就当成点击（展开），拖动不会顺带把窗口打开
 * - 关闭做什么由调用方定：AI 分析窗口只收窗口、分析继续在后台跑，AI 优化窗口会停掉那次生成
 */
export function MinimizedChat({
  id,
  slot = 0,
  label,
  state,
  unseen,
  onExpand,
  onClose,
}: {
  /** 位置记忆的键，也是「跟别的浮条错开」的标识 */
  id: string
  /** 没拖过时从右下角往上排第几档：两个窗口同时最小化也不会叠在一起 */
  slot?: number
  label: string
  state: ChatDockState
  /** 最小化期间出了结果：没展开过之前在浮条上点一下红点 */
  unseen?: boolean
  onExpand: () => void
  onClose: () => void
}) {
  const [pos, setPos] = useState<Pos | null>(() => loadPos(id))
  const [dragging, setDragging] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  // 拖动中的位置同步记一份：松手时直接存，不用等 state 更新
  const latest = useRef<Pos | null>(pos)
  const from = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  // 这次按下是要移动还是点了「关闭」（没按在关闭上 = 展开）
  const intent = useRef<'expand' | 'close'>('expand')
  // 按下后是否真的移动过：没移动就把这次当成点击
  const moved = useRef(false)
  // 鼠标点击在 pointerup 里处理，随后浏览器可能再发一次 click（键盘触发也走 click），这串时间去重
  const clickedAt = useRef(0)

  const moveTo = (p: Pos) => {
    latest.current = p
    setPos(p)
  }

  // 夹回视口时用 offsetWidth/offsetHeight：浮条刚出现时 pop-in 在缩放，getBoundingClientRect 会偏小
  const clampTo = (p: Pos, el: HTMLElement) =>
    clampPos(p, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = bar.current
    if (!el) return
    const r = el.getBoundingClientRect()
    from.current = { px: e.clientX, py: e.clientY, x: r.left, y: r.top }
    moved.current = false
    intent.current = (e.target as HTMLElement).closest('[data-dock="close"]') ? 'close' : 'expand'
    // 按下就捕获：鼠标一下子甩出浮条也能拖到底
    el.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = from.current
    const el = bar.current
    if (!f || !el) return
    const dx = e.clientX - f.px
    const dy = e.clientY - f.py
    if (!moved.current) {
      if (!movedEnough(dx, dy)) return
      moved.current = true
      setDragging(true)
    }
    moveTo(clampTo({ x: f.x + dx, y: f.y + dy }, el))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, click = true) => {
    const el = bar.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    if (!from.current) return
    from.current = null
    setDragging(false)
    if (moved.current || !click) {
      moved.current = false
      // 松手时再按当前尺寸收一次：拖动中窗口可能被改小过
      if (el && latest.current) {
        const p = clampTo(latest.current, el)
        moveTo(p)
        savePos(id, p)
      }
      return
    }
    // 没移动：这次是一次点击
    clickedAt.current = Date.now()
    if (intent.current === 'close') onClose()
    else onExpand()
  }
  // 鼠标点击在 pointerup 里做过一次了，按钮的 click 只留给键盘触发
  const clickGuard = (fn: () => void) => () => {
    if (Date.now() - clickedAt.current < CLICK_GUARD) return
    fn()
  }

  // 窗口变小后浮条可能有一半在屏幕外，跟着收回来（位置也会记住）
  useEffect(() => {
    if (!pos) return
    const onResize = () => {
      const el = bar.current
      if (!el || !latest.current) return
      const p = clampTo(latest.current, el)
      moveTo(p)
      savePos(id, p)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos, id])

  return createPortal(
    <div
      ref={bar}
      role="group"
      aria-label={label}
      title={t('拖动可以移动位置')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e)}
      onPointerCancel={(e) => endDrag(e, false)}
      style={
        pos ? { left: pos.x, top: pos.y } : { right: DEFAULT_INSET, bottom: DEFAULT_INSET + slot * (DOCK_H + GAP) }
      }
      className={cn(
        // pointer-events-auto：弹窗打开时 Radix 会关掉外面区域的鼠标事件，浮条要能点
        // z-[60]：跟另一个窗口的最小化浮条一致，放到所有弹窗之上——进度得一直看得到、点得到
        // portal 到 body：弹窗里可能有 transform / overflow，fixed 会跟着它跑而不是跟着视口
        'pointer-events-auto fixed z-[60] flex h-11 touch-none items-center gap-1 rounded-full border border-line-strong bg-panel pr-1.5 pl-3 text-[0.8125rem] shadow-xl select-none animate-[pop-in_160ms_ease-out]',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
    >
      <button
        type="button"
        onClick={clickGuard(onExpand)}
        title={t('展开')}
        aria-label={t('展开')}
        className="flex min-w-0 cursor-grab items-center gap-2 rounded-full text-left"
      >
        <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          {state === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {unseen && state !== 'running' && (
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent" />
          )}
        </span>
        <span className="max-w-[220px] truncate">{label}</span>
        <span className="text-xs text-subtle">{stateText(state)}</span>
      </button>
      <button
        type="button"
        data-dock="close"
        onClick={clickGuard(onClose)}
        title={t('关闭')}
        aria-label={t('关闭')}
        className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-subtle transition-colors hover:bg-sel hover:text-fg"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>,
    document.body,
  )
}
