import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 贴边时留一点空隙，拖到角上也不会只剩一条边露在外面 */
const EDGE = 8
/** 按下后移动超过这个距离才算拖动，手抖不会把点击吃掉 */
const SLOP = 4

function clamp(x: number, y: number, w: number, h: number) {
  // 窗口比浮条还窄时上限会小于下限，取 EDGE 保证位置合法
  const maxX = Math.max(EDGE, window.innerWidth - w - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - h - EDGE)
  return { x: Math.min(Math.max(EDGE, x), maxX), y: Math.min(Math.max(EDGE, y), maxY) }
}

/**
 * 最小化后的浮条：可以拖到任意位置（本次对话期间不再跳回去），右侧有展开和关闭。
 * 拖动被限制在窗口内；拖动不触发展开，关闭是真的把这次生成停掉。
 */
export function AssistDock({
  label,
  running,
  unseen,
  onExpand,
  onClose,
}: {
  label: string
  running: boolean
  unseen: boolean
  onExpand: () => void
  onClose: () => void
}) {
  // 位置按左上角记：没拖过时用右下角的默认位置，拖过之后一直按这个坐标
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const from = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  // 这次按下是要移动还是点了「关闭」（没按钮时按在浮条本身上 = 展开）
  const intent = useRef<'expand' | 'close'>('expand')
  // 按下后是否真的移动过：没移动就把这次当成点击
  const moved = useRef(false)
  // 鼠标点击在 pointerup 里处理，随后浏览器可能再发一次 click（键盘触发也走 click），这串时间去重
  const clickedAt = useRef(0)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = bar.current
    if (!el) return
    const r = el.getBoundingClientRect()
    from.current = { px: e.clientX, py: e.clientY, x: r.left, y: r.top }
    moved.current = false
    intent.current = (e.target as HTMLElement).closest('[data-dock="close"]') ? 'close' : 'expand'
    // 按下就捕获：鼠标一下子甩出浮条也能拖到底；点了没动就在 pointerup 里补上点击
    el.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = from.current
    const el = bar.current
    if (!f || !el) return
    const dx = e.clientX - f.px
    const dy = e.clientY - f.py
    if (!moved.current) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
      moved.current = true
      setDragging(true)
    }
    const r = el.getBoundingClientRect()
    setPos(clamp(f.x + dx, f.y + dy, r.width, r.height))
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
      const r = el?.getBoundingClientRect()
      if (el && r) setPos((p) => (p ? clamp(p.x, p.y, r.width, r.height) : p))
      return
    }
    // 没移动：这次是一次点击
    clickedAt.current = Date.now()
    if (intent.current === 'close') onClose()
    else onExpand()
  }
  // 鼠标点击在 pointerup 里做过一次了，按钮的 click 只留给键盘触发
  const clickGuard = (fn: () => void) => () => {
    if (Date.now() - clickedAt.current < 500) return
    fn()
  }

  // 窗口变小后浮条可能有一半在屏幕外，跟着收回来
  useEffect(() => {
    if (!pos) return
    const onResize = () => {
      const el = bar.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setPos((p) => (p ? clamp(p.x, p.y, r.width, r.height) : p))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos])

  return createPortal(
    <div
      ref={bar}
      role="group"
      aria-label={t('AI 优化进度')}
      title={t('拖动可以移动位置')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e)}
      onPointerCancel={(e) => endDrag(e, false)}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      className={cn(
        // pointer-events-auto：弹窗打开时 Radix 会关掉外面区域的鼠标事件，浮条要能点
        // z-[60]：跟 AI 排查浮条一致，放到所有弹窗之上——生成进度得一直看得到、点得到
        // portal 到 body：弹窗里可能有 transform / overflow，fixed 会跟着它跑而不是跟着视口
        'pointer-events-auto fixed z-[60] flex h-11 touch-none items-center gap-1 rounded-full border border-line-strong bg-panel pr-1.5 pl-3 text-[0.8125rem] shadow-xl select-none animate-[pop-in_160ms_ease-out]',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
        !pos && 'right-5 bottom-5',
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
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {unseen && !running && <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent" />}
        </span>
        <span className="max-w-[220px] truncate">{label}</span>
        <span className="text-xs text-subtle">{running ? t('生成中…') : unseen ? t('已生成') : ''}</span>
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
