import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskMessage } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 少于这么多轮时不显示：只有一轮没什么可跳的 */
const MIN_TURNS = 2
/** 鼠标离开横杠和预览后隔这么久才收起：从横杠挪到预览卡片上、或者在横杠之间滑过空隙时不闪 */
const CLOSE_MS = 160
/** 「当前在看的那一轮」：用户消息的顶端越过消息区上面这个比例的位置就算看到了这一轮 */
const READ_LINE = 0.35
/** 预览卡片顶端比悬停的横杠高出多少：鼠标落在卡片标题行旁边 */
const CARD_LIFT = 12

/** 预览里一段文字的长度上限：卡片只给个大意，超出部分靠行数截断，这里只是免得把整段长日志塞进 DOM */
const clip = (text: string, n: number) => {
  // Markdown 的标记符号在预览里只是噪音（回复多是 Markdown），去掉再截
  const s = text.replace(/[`*_#>]+/g, '').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

type Turn = { id: string; ask: string; reply: string; at: string }

/** 按用户发的每条要求分轮；回复取它后面第一条有正文的 Agent 消息（对话本身的，不算工作流节点） */
function toTurns(msgs: TaskMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of msgs) {
    if (m.step) continue
    if (m.role === 'user' && !m.peer && m.text.trim())
      turns.push({ id: m.id, ask: clip(m.text, 600), reply: '', at: m.at })
    else if (m.role === 'agent' && m.text.trim()) {
      const last = turns.at(-1)
      if (last && !last.reply) last.reply = clip(m.text, 400)
    }
  }
  return turns
}

/**
 * 对话右上角的轮次导航：每条要求一根短横杠，从上到下和对话顺序一致，正在看的那一轮高亮。
 * 鼠标在横杠上滑动时，左边弹出那一轮的要求和回复开头，跟着鼠标上下移；点横杠或卡片跳到那一轮
 * （更早被折叠的段由 onJump 先显示出来）
 */
export function TurnRail({
  msgs,
  scrollEl,
  onJump,
  right,
}: {
  msgs: TaskMessage[]
  /** 消息区的滚动容器：跟着滚动算出正在看的那一轮 */
  scrollEl: React.RefObject<HTMLElement | null>
  onJump: (msgId: string) => void
  /** 离消息区右边多远：避开滚动条，有会话栏时还要让出会话栏 */
  right: number
}) {
  const turns = useMemo(() => toTurns(msgs), [msgs])
  const [current, setCurrent] = useState(-1)
  const [hover, setHover] = useState<{ i: number; top: number } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const railRef = useRef<HTMLDivElement>(null)

  // 跟着滚动找正在看的那一轮：最后一条顶端已经越过阅读线的用户消息。没画出来的（更早被折叠的段）找不到，跳过
  useEffect(() => {
    const el = scrollEl.current
    if (!el || turns.length < MIN_TURNS) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = el.getBoundingClientRect()
      const line = box.top + box.height * READ_LINE
      let at = -1
      turns.forEach((turn, i) => {
        const node = el.querySelector(`[data-msg="${CSS.escape(turn.id)}"]`)
        if (node && node.getBoundingClientRect().top <= line) at = i
      })
      // 一轮都没越过（停在最上面）时算第一轮
      setCurrent(at < 0 ? 0 : at)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollEl, turns])

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  if (turns.length < MIN_TURNS) return null

  const keep = () => clearTimeout(closeTimer.current)
  const leave = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHover(null), CLOSE_MS)
  }
  const enter = (i: number, dash: HTMLElement) => {
    keep()
    const rail = railRef.current
    if (!rail) return
    // 卡片顶端对齐到横杠上方一点，相对整个导航（横杠一列可能滚动过，所以按实际位置量）。
    // 不按横杠居中：导航贴着消息区顶端，居中会让上半张卡片被页签栏裁掉
    const top = dash.getBoundingClientRect().top - rail.getBoundingClientRect().top - CARD_LIFT
    setHover({ i, top: Math.max(0, top) })
  }
  const shown = hover ? turns[hover.i] : undefined

  return (
    <div
      ref={railRef}
      data-turn-rail
      className="absolute top-3 z-20"
      style={{ right }}
      onMouseLeave={leave}
      onMouseEnter={keep}
    >
      <nav
        aria-label={t('跳到某一轮')}
        className="flex max-h-[min(60vh,32rem)] flex-col items-end overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {turns.map((turn, i) => {
          const on = i === current
          const lit = hover?.i === i
          return (
            <button
              key={turn.id}
              type="button"
              aria-label={t('第 {n} 轮：{text}', { n: i + 1, text: clip(turn.ask, 40) })}
              aria-current={on ? 'true' : undefined}
              onMouseEnter={(e) => enter(i, e.currentTarget)}
              onFocus={(e) => enter(i, e.currentTarget)}
              onBlur={leave}
              onClick={() => onJump(turn.id)}
              // 横杠本身只有 2px 高，按钮留出上下各几像素的命中区，滑过时一根接一根地点亮
              className="group/dash flex h-2.5 w-7 shrink-0 cursor-pointer items-center justify-end outline-none"
            >
              <span
                className={cn(
                  'h-0.5 rounded-full transition-all duration-150 ease-out',
                  lit ? 'w-5 bg-fg' : on ? 'w-4 bg-accent-text' : 'w-3 bg-line-strong group-hover/dash:bg-muted',
                )}
              />
            </button>
          )
        })}
      </nav>
      {shown && hover && (
        // 卡片只在打开时挂上、播一次弹出动画；之后在横杠间滑动只平移外层（transition top），不重复弹
        <div
          role="tooltip"
          className="absolute right-full mr-2 w-[min(320px,calc(100vw-5rem))] transition-[top] duration-150 ease-out"
          style={{ top: hover.top }}
        >
          <button
            type="button"
            onClick={() => onJump(shown.id)}
            className="block w-full cursor-pointer rounded-xl border border-line-strong bg-card p-3 text-left shadow-pop animate-[turn-peek-in_160ms_ease-out]"
          >
            <div className="mb-1 flex items-center gap-2 text-[0.6875rem] text-subtle">
              <span className="font-medium">{t('第 {n} 轮', { n: hover.i + 1 })}</span>
              <span className="ml-auto tabular-nums">{shown.at.slice(5, 16).replace('T', ' ')}</span>
            </div>
            <p className="line-clamp-4 text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
              {shown.ask}
            </p>
            {shown.reply && (
              <p className="mt-2 line-clamp-3 border-t border-line pt-2 text-[0.75rem] leading-relaxed text-muted [overflow-wrap:anywhere]">
                {shown.reply}
              </p>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
