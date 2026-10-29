import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { addDock, dockSnapshot, dockVisible, subscribeDock, type ChatDockState } from '@/lib/chat-dock'
import { Spinner, StatusPill, type StatusTone } from './status-pill'
import { DEFAULT_INSET, clampPos, loadPos, movedEnough, savePos, type Pos } from '@/lib/minimized-chat'

export type { ChatDockState }

/** 拖动刚结束后浏览器可能补发一次 click，这串时间去重 */
const CLICK_GUARD = 500

/**
 * 关闭按钮：小圆直径 + 它在浮条右上角往里缩的距离（px）。
 * 浮条是 h-11 的胶囊，右上角是半径 22px 的弧，小圆贴像素级的角会看着飘在胶囊外，
 * 内缩后恰好落在弧内、又仍是视觉上的右上角；按钮矩形本身从浮条右上顶角起算，
 * 鼠标放到浮条右上角就能点到。
 */
const CLOSE_SIZE = 20
const CLOSE_INSET_X = 9
const CLOSE_INSET_Y = 5
/** 主体按钮右侧留的空白：让开右上角的关闭按钮，文字不被它压住 */
const CLOSE_RESERVE = CLOSE_SIZE + CLOSE_INSET_X
/** 悬停浮条才显示关闭按钮，淡入淡出 */
const CLOSE_FADE =
  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity'

/** 浮条上的状态文字：三类浮条共用同一套，看起来才是同一个东西 */
const stateText = (s: ChatDockState) =>
  s === 'running'
    ? t('进行中…')
    : s === 'needs'
      ? t('等你处理')
      : s === 'failed'
        ? t('失败')
        : s === 'done'
          ? t('已完成')
          : s === 'ended'
            ? t('已结束')
            : s === 'gone'
              ? t('对话已关闭')
              : ''

/** 状态胶囊的颜色：和 AI 分析窗口标题栏、对话状态用同一套（运行青、完成绿、等你琥珀、失败红） */
const stateTone: Record<ChatDockState, StatusTone> = {
  running: 'run',
  needs: 'wait',
  failed: 'err',
  done: 'ok',
  ended: 'idle',
  gone: 'idle',
  idle: 'idle',
}

/**
 * 最小化后的浮条：「AI 处理」「AI 优化」和收起来的对话都用它，形状、层级、动效、状态文字保持一致。
 *
 * - 屏幕任意时刻只显示一个浮条：组件挂载即登记到 chat-dock，只有栈顶那个渲染，
 *   被顶掉的不销毁、留着等栈顶让位（用户要的是「同时只能存在一个最小化弹窗」）
 * - 可以拖到任意位置，松手后夹回视口内并记进 localStorage（按 id 分开记，各自回到自己的位置）
 * - 拖动用 pointer 事件 + 指针捕获，不用 HTML5 draggable：那样拖不出窗口外、也拿不到稳定的坐标
 * - 移动没超过阈值就当成点击（展开），拖动不会顺带把窗口打开
 * - 关闭做什么由调用方定：AI 分析窗口只收窗口、分析继续在后台跑，AI 优化窗口会停掉那次生成，
 *   对话浮条只是收起（对话照常留在列表里）
 */
export function MinimizedChat({
  id,
  label,
  state,
  unseen,
  onExpand,
  onClose,
}: {
  /** 位置记忆的键，也是互斥计数里的标识；同一个 id 只能同时有一条浮条 */
  id: string
  label: string
  state: ChatDockState
  /** 最小化期间出了结果：没展开过之前在浮条上点一下红点 */
  unseen?: boolean
  onExpand: () => void
  onClose: () => void
}) {
  const [pos, setPos] = useState<Pos | null>(() => loadPos(id))
  const [dragging, setDragging] = useState(false)
  // 浮条互斥：挂载即登记，只有最后一个登记的（栈顶）显示，其余的等它让位。
  // 登记用 useId 生成的实例号而不是 id：同一个 id 可能同时挂好几份（`AssistDialog` 在几个页面各挂一份），
  // 按 id 判会让它们都以为自己是栈顶，互斥就被绕过了。
  // getSnapshot 必须返回稳定引用（见 chat-dock.ts 的 dockSnapshot），否则这里会无限重渲染
  const instance = useId()
  const docks = useSyncExternalStore(subscribeDock, dockSnapshot, dockSnapshot)
  const mine = dockVisible(instance, docks)
  useEffect(() => addDock(instance), [instance])
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

  if (!mine) return null
  return createPortal(
    <div
      ref={bar}
      role="group"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e)}
      onPointerCancel={(e) => endDrag(e, false)}
      style={pos ? { left: pos.x, top: pos.y } : { right: DEFAULT_INSET, bottom: DEFAULT_INSET }}
      // group 给右上角关闭按钮的悬停显示当开关；浮条本身就是 position:fixed，
      // 它已经是关闭按钮的定位参照，不再加 relative（会把 fixed 顶掉）
      className={cn(
        // pointer-events-auto：弹窗打开时 Radix 会关掉外面区域的鼠标事件，浮条要能点
        // z-[60]：跟另一个窗口的最小化浮条一致，放到所有弹窗之上——进度得一直看得到、点得到
        // portal 到 body：弹窗里可能有 transform / overflow，fixed 会跟着它跑而不是跟着视口
        'pointer-events-auto group fixed z-[60] flex h-11 touch-none items-center rounded-full border border-line-strong bg-bg text-[0.8125rem] shadow-pop select-none animate-[pop-in_160ms_ease-out]',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
    >
      {/* 主体是按钮：点一下展开。不挂 title —— 它几乎盖满浮条，原生提示一悬停就弹出来，用户嫌烦；
          名字留给读屏的 aria-label */}
      <button
        type="button"
        onClick={clickGuard(onExpand)}
        aria-label={t('展开')}
        className={cn(
          'flex min-w-0 cursor-grab items-center gap-2 rounded-full py-2 pl-3 text-left',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{ paddingRight: CLOSE_RESERVE }}
      >
        {/* 图标和 AI 分析窗口标题栏的同一个：深底方块 + 星芒，在跑时换成转圈 */}
        <span className="relative grid h-[1.625rem] w-[1.625rem] shrink-0 place-items-center rounded-lg bg-fg text-bg">
          {state === 'running' ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3.5 w-3.5" />}
          {unseen && state !== 'running' && (
            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg" />
          )}
        </span>
        <span className="max-w-[220px] truncate font-medium">{label}</span>
        {stateText(state) && (
          <StatusPill tone={stateTone[state]} spin={state === 'running'}>
            {stateText(state)}
          </StatusPill>
        )}
      </button>
      {/* 关闭在浮条右上角，鼠标进浮条才显示（触屏、键盘聚焦时也显示）：
          按钮矩形从浮条右上顶角起算（含内缩留白），鼠标放到浮条右上角就能点到；
          opacity-0 只是看不见、屏幕位置照样能点，不用 hidden / invisible，否则淡出后键盘也碰不到 */}
      <button
        type="button"
        data-dock="close"
        onClick={clickGuard(onClose)}
        aria-label={t('关闭')}
        className={cn('absolute top-0 right-0 grid cursor-pointer place-items-start justify-items-end', CLOSE_FADE)}
        style={{
          width: CLOSE_SIZE + CLOSE_INSET_X,
          height: CLOSE_SIZE + CLOSE_INSET_Y,
          paddingTop: CLOSE_INSET_Y,
          paddingRight: CLOSE_INSET_X,
        }}
      >
        <span
          className="grid place-items-center rounded-full bg-bg text-subtle shadow-sm ring-1 ring-line-strong transition-colors hover:bg-sel hover:text-fg"
          style={{ width: CLOSE_SIZE, height: CLOSE_SIZE }}
        >
          <X className="h-3 w-3" />
        </span>
      </button>
    </div>,
    document.body,
  )
}
