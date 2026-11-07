import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 少于这么多个标题不画：一两个标题没什么可跳的 */
const MIN_HEADINGS = 3
/** 鼠标离开刻度条和目录后隔这么久才收起：从刻度条挪到目录卡片上、或者擦过边缘时不闪 */
const CLOSE_MS = 160
/** 「正在看的那一节」：标题顶端越过阅读线就算读到了这一节。阅读线在滚动区上面这个比例处，但最多离顶边 READ_MAX：
 * 弹窗很高时按比例算，开头一屏里第二个标题就会抢走第一个的高亮 */
const READ_LINE = 0.3
const READ_MAX = 96
/** 跳过去时标题离滚动区顶边（或吸顶条下沿）留的空 */
const JUMP_GAP = 12

type Heading = { el: HTMLElement; text: string; level: number }

/** 各级标题的刻度长度（px），按文档里实际出现的最高一级算第 0 级：一级最长，往下逐级变短 */
const DASH = [14, 10, 7, 5]
/** 目录里每一级缩进（px），和刻度一样按文档里最高的一级算起 */
const INDENT = 14

/** 从渲染好的 Markdown 里收标题：只认正文里的 h1–h4，代码块、图里的 # 不是标题元素，不会混进来 */
function collect(root: HTMLElement): Heading[] {
  const els = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4')]
  const list = els
    .map((el) => ({ el, text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), level: Number(el.tagName[1]) }))
    .filter((h) => h.text)
  const top = Math.min(...list.map((h) => h.level))
  return list.map((h) => ({ ...h, level: Math.min(h.level - top, DASH.length - 1) }))
}

/** 标题列表没变（同一批元素、同样的字）就不换 state：Markdown 里别的地方变了（图画好、标记校验）不重画目录 */
const same = (a: Heading[], b: Heading[]) =>
  a.length === b.length && a.every((h, i) => h.el === b[i].el && h.text === b[i].text && h.level === b[i].level)

/** 正贴在滚动区顶上的吸顶条（毛玻璃 .frost-bar）有多高：目录从它下沿往下排，跳转时标题也停在它下面 */
function stickyGap(box: HTMLElement) {
  const top = box.getBoundingClientRect().top
  let gap = 0
  for (const bar of box.querySelectorAll<HTMLElement>('.frost-bar')) {
    const r = bar.getBoundingClientRect()
    if (r.top <= top + 2 && r.bottom > top) gap = Math.max(gap, r.bottom - top)
  }
  return Math.round(gap)
}

/**
 * Markdown 文档的标题目录，参照 Claude Code：平时是贴在右边的一列刻度，每个标题一根、按级别长短不同，
 * 正在看的那一节高亮；鼠标移上去（或键盘聚焦）原地展开成目录卡片，列出标题、按级缩进，点一下跳过去。
 *
 * 放在滚动区的「兄弟」位置：外层要有 relative，滚动区本身滚动时目录不跟着走。
 * 标题从渲染好的 DOM 里读（h1–h4），内容变了（切版本、编辑后切回阅读）自动重收。
 * 用在 Markdown 文件弹窗和诊断报告这类长文档里；对话页有自己的轮次导航（TurnRail），不用这个
 */
export function DocOutline({
  scrollEl,
  className,
}: {
  /** 文档的滚动容器：标题从这里面找，跟着它的滚动算正在看哪一节 */
  scrollEl: React.RefObject<HTMLElement | null>
  /** 定位微调，例如离右边多远（默认 right-3 避开滚动条） */
  className?: string
}) {
  const [heads, setHeads] = useState<Heading[]>([])
  const [current, setCurrent] = useState(0)
  const [open, setOpen] = useState(false)
  const [gap, setGap] = useState(0)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const railRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const headsRef = useRef(heads)
  headsRef.current = heads

  // 算正在看的那一节：最后一个顶端越过阅读线的标题；滚到底时算最后一节（最后几节短，标题永远到不了阅读线）
  const measure = useCallback(() => {
    const box = scrollEl.current
    const list = headsRef.current
    if (!box || !list.length) return
    const r = box.getBoundingClientRect()
    const g = stickyGap(box)
    setGap(g)
    const line = r.top + g + Math.min((r.height - g) * READ_LINE, READ_MAX)
    let at = 0
    list.forEach((h, i) => {
      if (h.el.getBoundingClientRect().top <= line) at = i
    })
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) at = list.length - 1
    setCurrent(at)
  }, [scrollEl])

  // 收标题：内容是 dangerouslySetInnerHTML 画的，换版本、切阅读 / 编辑都会整块换掉，用 MutationObserver 跟着重收
  useEffect(() => {
    const box = scrollEl.current
    if (!box) return
    let frame = 0
    const scan = () => {
      frame = 0
      const next = collect(box)
      if (!same(next, headsRef.current)) {
        headsRef.current = next
        setHeads(next)
      }
      measure()
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(scan)
    }
    scan()
    const mo = new MutationObserver(later)
    mo.observe(box, { childList: true, subtree: true, characterData: true })
    box.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(box)
    return () => {
      mo.disconnect()
      ro.disconnect()
      box.removeEventListener('scroll', later)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollEl, measure])

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  // 标题多到一列放不下时，刻度条和目录卡片都自己滚：让正在看的那一项留在可见范围里（只滚自己，不带动文档）
  useEffect(() => {
    for (const box of [railRef.current, listRef.current]) {
      const item = box?.querySelector<HTMLElement>(`[data-outline="${current}"]`)
      if (!box || !item) continue
      const top = item.offsetTop - box.clientHeight / 2 + item.offsetHeight / 2
      box.scrollTop = Math.max(0, top)
    }
  }, [current, open, heads])

  if (heads.length < MIN_HEADINGS) return null

  const keep = () => clearTimeout(closeTimer.current)
  const show = () => {
    keep()
    setOpen(true)
  }
  const hide = (now?: boolean) => {
    keep()
    if (now) return setOpen(false)
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_MS)
  }
  const jump = (i: number) => {
    const box = scrollEl.current
    const h = heads[i]
    if (!box || !h) return
    const top = h.el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTo({ top: Math.max(0, top - stickyGap(box) - JUMP_GAP), behavior: 'smooth' })
    setCurrent(i)
  }

  const dash = (level: number, on: boolean, lit?: boolean) => (
    <span
      aria-hidden
      style={{ width: DASH[level] }}
      className={cn(
        'h-0.5 shrink-0 rounded-full transition-colors duration-150',
        on ? 'bg-accent-text' : lit ? 'bg-subtle/70' : 'bg-line-strong',
      )}
    />
  )

  return (
    <div
      data-doc-outline
      // 整块不接鼠标，只有刻度条和卡片接：底下的正文照样能选中、能点。窄屏正文没有留白，刻度会压字，不画
      className={cn('pointer-events-none absolute right-3 max-sm:hidden bottom-3 z-20 flex justify-end', className)}
      style={{ top: gap + 12 }}
      onMouseLeave={() => hide()}
      onMouseEnter={keep}
      // 焦点离开整块（刻度条和卡片都算里面）才收起：Tab 从刻度条走进卡片时不收
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hide()
      }}
    >
      {/* 收起时：一列刻度。整列是一个按钮，键盘聚焦或点一下展开目录 */}
      <button
        type="button"
        aria-label={t('文档目录')}
        aria-expanded={open}
        onMouseEnter={show}
        onFocus={show}
        onClick={() => setOpen(true)}
        className={cn(
          'pointer-events-auto flex max-h-full w-6 cursor-pointer flex-col items-start self-start rounded-md py-1 pl-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          // 展开时卡片盖在上面；只是看不见，不用 invisible——那样键盘聚焦的刻度条会丢焦点，Tab 进不了卡片
          open && 'opacity-0',
        )}
      >
        <div
          ref={railRef}
          className="relative flex min-h-0 w-full flex-col overflow-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {heads.map((h, i) => (
            <span key={i} data-outline={i} className="flex h-2 shrink-0 items-center">
              {dash(h.level, i === current)}
            </span>
          ))}
        </div>
      </button>
      {open && (
        // 展开：原地盖住刻度条的目录卡片，左边一列还是刻度（和收起时一一对应），右边是标题、按级缩进
        <nav
          aria-label={t('文档目录')}
          onMouseEnter={keep}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // 只收起目录，不把外面的弹窗也关掉
              e.stopPropagation()
              hide(true)
            }
          }}
          className="pointer-events-auto absolute top-0 right-0 flex max-h-full w-[min(300px,calc(100vw-4rem))] flex-col rounded-xl border border-line-strong bg-card py-1.5 shadow-pop animate-[turn-peek-in_140ms_ease-out]"
        >
          <div ref={listRef} className="relative min-h-0 overflow-y-auto px-1.5">
            {heads.map((h, i) => {
              const on = i === current
              return (
                <button
                  key={i}
                  type="button"
                  data-outline={i}
                  title={h.text}
                  aria-current={on ? 'location' : undefined}
                  onClick={() => jump(i)}
                  className={cn(
                    'group/row flex w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-2 pl-1 text-left text-footnote outline-none hover:bg-sel focus-visible:bg-sel',
                    on ? 'text-fg' : h.level === 0 ? 'text-fg/90' : 'text-muted hover:text-fg',
                  )}
                >
                  <span className="flex w-4 shrink-0 items-center">{dash(h.level, on, true)}</span>
                  <span
                    style={{ paddingLeft: h.level * INDENT }}
                    className={cn('min-w-0 flex-1 truncate', h.level === 0 && 'font-medium')}
                  >
                    {h.text}
                  </span>
                </button>
              )
            })}
          </div>
        </nav>
      )}
    </div>
  )
}
