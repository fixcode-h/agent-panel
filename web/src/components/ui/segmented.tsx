import { useLayoutEffect, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 选中块滑动的时长：和 index.css 的 --dur-base 一致，动画结束后把选中底交还给按钮本身 */
const SLIDE_MS = 200

/** 分段单选：选项少、想一眼看全时用，比下拉框直观 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
  fill = false,
  tone = 'default',
  iconOnly = false,
}: {
  value: T
  onChange: (v: T) => void
  /** dot：选项上的提示点（例如那一页有要处理的事），文字放在悬停提示里 */
  /** icon：文字前的小图标（iconOnly 时只画它，label 进读屏名和悬停提示） */
  options: { id: T; label: string; disabled?: boolean; dot?: string; icon?: LucideIcon }[]
  label: string
  /** 撑满一行、换底色等版式调整；不传时和原来一样 */
  className?: string
  /** sm：页头工具条里用（比如计划页的「周 / 月 / 列表」），和 sm 按钮同高 */
  size?: 'sm' | 'md'
  /** 撑满一行、每段等宽（计划详情里的「重复」照设计稿就是这样）；不传时按文字宽度排 */
  fill?: boolean
  /** canvas：放在深色画布（设计页画板、预览台）上，轨道和选中块用 --canvas-* 这组色，不跟主题变 */
  tone?: 'default' | 'canvas'
  /** 只画图标的方块段（设计页的「桌面 / 平板 / 手机」）；不传时和原来一样写文字 */
  iconOnly?: boolean
}) {
  const canvas = tone === 'canvas'
  const groupRef = useRef<HTMLDivElement>(null)
  const slideRef = useRef<HTMLSpanElement>(null)
  const prev = useRef(value)
  // 切换时选中块从旧位置滑到新位置（照 Claude Code 的分段切换）。平时选中底画在按钮自己身上（界面检查按它量对比度），
  // 只在滑动的 200ms 里藏起按钮的底、由一块独立的滑块代画，结束后交还；关了动效就直接跳
  useLayoutEffect(() => {
    const from = prev.current
    prev.current = value
    const g = groupRef.current
    const el = slideRef.current
    if (from === value || !g || !el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const a = g.querySelector<HTMLElement>(`[data-seg-id="${CSS.escape(from)}"]`)
    const b = g.querySelector<HTMLElement>(`[data-seg-id="${CSS.escape(value)}"]`)
    if (!a || !b) return
    const box = (n: HTMLElement) => `translate(${n.offsetLeft}px, ${n.offsetTop}px)`
    el.style.transition = 'none'
    el.style.width = `${a.offsetWidth}px`
    el.style.height = `${a.offsetHeight}px`
    el.style.transform = box(a)
    g.dataset.sliding = ''
    void el.offsetWidth
    el.style.transition = ''
    el.style.width = `${b.offsetWidth}px`
    el.style.height = `${b.offsetHeight}px`
    el.style.transform = box(b)
    const done = window.setTimeout(() => delete g.dataset.sliding, SLIDE_MS)
    return () => window.clearTimeout(done)
  }, [value])
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className={cn(
        'group/seg relative inline-flex max-w-full flex-wrap rounded-(--c-segmented-radius) p-0.5',
        canvas ? 'bg-canvas-bar text-canvas-fg' : 'seg-track',
        fill && 'flex w-full',
        className,
      )}
    >
      <span
        ref={slideRef}
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-0 left-0 hidden rounded-(--c-segmented-itemRadius) transition-[transform,width,height] duration-(--dur-base) ease-(--ease-snap) group-data-[sliding]/seg:block',
          canvas ? 'bg-canvas-sel' : 'seg-thumb',
        )}
      />
      {options.map((o) => (
        <button
          key={o.id}
          data-seg-id={o.id}
          role="radio"
          aria-checked={value === o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          aria-label={iconOnly ? o.label : undefined}
          title={o.dot ?? (iconOnly ? o.label : undefined)}
          className={cn(
            'relative inline-flex cursor-pointer items-center gap-1.5 rounded-(--c-segmented-itemRadius) px-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            // 滑动期间选中底由滑块代画，按钮自己的底先藏起来
            'group-data-[sliding]/seg:bg-transparent! group-data-[sliding]/seg:shadow-none!',
            fill && 'flex-1 justify-center px-2 whitespace-nowrap',
            iconOnly && (size === 'sm' ? 'w-7 justify-center px-0' : 'w-8 justify-center px-0'),
            size === 'sm' ? 'h-7 text-[0.75rem]' : 'h-8 text-[0.8125rem]',
            value === o.id
              ? canvas
                ? 'bg-canvas-sel font-medium text-canvas-strong'
                : 'seg-thumb font-medium'
              : canvas
                ? 'text-canvas-fg hover:text-canvas-strong'
                : 'text-muted hover:text-fg',
          )}
        >
          {o.icon && <o.icon className={iconOnly ? 'h-4 w-4' : 'h-3.5 w-3.5'} strokeWidth={2.2} />}
          {!iconOnly && o.label}
          {o.dot && <span aria-label={o.dot} className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  )
}
