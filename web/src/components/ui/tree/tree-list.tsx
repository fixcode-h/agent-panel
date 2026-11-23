import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Caret } from './caret'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 摊平后的一行：树按展开状态摊成一列再渲染，只画看得见的那一段（几万个 Actor 也不卡） */
export interface TreeLine {
  key: string
  depth: number
  label: ReactNode
  icon: LucideIcon
  /** 图标颜色的类名（资源按类型上色）；不给是灰色 */
  iconTone?: string
  /** 有子项：显示展开箭头 */
  expandable: boolean
  open: boolean
  selected: boolean
  /** 检视区正在看的东西是从这一行点引用过去的（设计稿第 4 节「from」状态）：左边一道强调色细条 */
  from?: boolean
  title?: string
  aside?: ReactNode
  onToggle?: () => void
  onSelect?: () => void
  /** 单击既选中又展开收起（文件夹这类「选中就是看里面」的行）；不给时有 onSelect 的行单击只选中、双击展开收起 */
  clickToggles?: boolean
  /** 双击这一行（UMG 控件树里的子界面：打开它自己的配置）：给了就不再用双击展开收起 */
  onDouble?: () => void
  /** 右键这一行（资源文件夹树的收藏、资源的「在 UE 编辑器打开」） */
  onMenu?: (e: MouseEvent) => void
  /** 鼠标移到这一行上（GameTest 的 Widget 树：悬停时在游戏画面上描边） */
  onHover?: () => void
  /** 行尾的小按钮（文件夹的收藏星标）：平时隐藏，悬停或键盘选中这一行才露出来；actionShown 时一直显示（已收藏） */
  action?: ReactNode
  actionShown?: boolean
}

const ROW = 28

/** 单击 / 回车：选中；没有选中动作或标了 clickToggles 的行同时展开收起 */
function activate(l: TreeLine) {
  l.onSelect?.()
  if (!l.onSelect || l.clickToggles) l.onToggle?.()
}

/**
 * 只渲染可见范围的树列表（行高固定 28px，照组件树的样式）：上下各多画 20 行，滚动时换。
 * 世界大纲、UObject 树、资源文件夹树共用；组件树行数少，还是 CompTree 自己画。
 * reveal：滚到 key 这一行（seq 变了才滚一次）。行是按需画的，没法对 DOM 调 scrollIntoView，按行号算位置
 */
export function TreeList({
  lines,
  label,
  reveal,
}: {
  lines: TreeLine[]
  label: string
  reveal?: { key: string; seq: number }
}) {
  const [scroll, setScroll] = useState({ top: 0, height: 800 })
  const box = useRef<HTMLDivElement>(null)
  const done = useRef(0)
  useEffect(() => {
    const el = box.current
    if (!reveal || !el || done.current === reveal.seq) return
    // 逐层读的时候行还没出来：等 lines 变了再找
    const i = lines.findIndex((l) => l.key === reveal.key)
    if (i < 0) return
    done.current = reveal.seq
    const top = i * ROW
    if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight)
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW / 2)
  }, [reveal, lines])
  const start = Math.max(0, Math.floor(scroll.top / ROW) - 20)
  const end = Math.min(lines.length, Math.ceil((scroll.top + scroll.height) / ROW) + 20)
  return (
    <div
      role="tree"
      aria-label={label}
      className="min-h-0 flex-1 overflow-auto py-1"
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      ref={(el) => {
        box.current = el
        if (el && Math.abs(el.clientHeight - scroll.height) > 40)
          setScroll({ top: el.scrollTop, height: el.clientHeight })
      }}
    >
      <div style={{ height: lines.length * ROW, position: 'relative' }}>
        {lines.slice(start, end).map((l, i) => {
          const Icon = l.icon
          return (
            <div
              key={l.key}
              role="treeitem"
              aria-selected={l.selected}
              aria-expanded={l.expandable ? l.open : undefined}
              tabIndex={0}
              title={l.title}
              onClick={() => activate(l)}
              // 单击只选中的行：双击整行展开收起，不必瞄准箭头（单击就展开的行不再接双击，免得点两下又收回去）
              onDoubleClick={
                l.onDouble ?? (l.onSelect && l.expandable && !l.clickToggles ? () => l.onToggle?.() : undefined)
              }
              onContextMenu={l.onMenu}
              onMouseEnter={l.onHover}
              onKeyDown={(e) => {
                if (e.key === 'Enter') activate(l)
                else if (e.key === 'ArrowLeft' && l.expandable && l.open) l.onToggle?.()
                else if (e.key === 'ArrowRight' && l.expandable && !l.open) l.onToggle?.()
              }}
              style={{ top: (start + i) * ROW, height: ROW, paddingLeft: 6 + l.depth * 16 }}
              className={cn(
                'group absolute inset-x-0 flex cursor-pointer items-center gap-1.5 pr-2 text-footnote select-none outline-none transition-colors focus-visible:bg-hover',
                l.selected ? 'bg-sel text-fg' : 'text-fg hover:bg-hover',
                l.from && 'bg-hover shadow-[inset_2px_0_0_var(--accent)]',
              )}
            >
              {l.expandable ? (
                <button
                  type="button"
                  aria-label={l.open ? t('收起') : t('展开')}
                  onClick={(e) => {
                    e.stopPropagation()
                    l.onToggle?.()
                  }}
                  // 箭头的点击区占满行高、比箭头宽一圈，不用瞄准那个小三角
                  className="-ml-1 flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-muted hover:text-fg"
                >
                  <Caret open={l.open} />
                </button>
              ) : (
                <span className="-ml-1 w-6 shrink-0" />
              )}
              <Icon className={cn('h-3.5 w-3.5 shrink-0', l.iconTone ?? 'text-muted')} />
              <span className="min-w-0 truncate">{l.label}</span>
              {l.aside && <span className="ml-auto shrink-0 pl-2 text-caption text-subtle">{l.aside}</span>}
              {l.action && (
                <span
                  className={cn(
                    'flex shrink-0 items-center',
                    !l.aside && 'ml-auto',
                    !l.actionShown && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                  )}
                >
                  {l.action}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
