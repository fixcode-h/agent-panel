import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Eye, EyeOff, Lock, Plus, Puzzle, Square } from 'lucide-react'
import {
  WIDGETS,
  isWebType,
  typesFor,
  canAddChild,
  entryCount,
  isHiddenVisibility,
  isPanel,
  pathTo,
  type Widget,
  type WidgetGroup,
  type WidgetType,
} from '@shared/umg'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { InlineRename } from '@/components/ui/inline-rename'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/menu'
import { t } from '@shared/i18n'
import { WIDGET_ICON, WidgetMenuItems, type WidgetMenuActions } from './WidgetMenu'

const GROUPS: { id: WidgetGroup; label: string }[] = [
  { id: 'panel', label: t('面板') },
  { id: 'list', label: t('列表（运行时生成）') },
  { id: 'common', label: t('常用') },
  { id: 'input', label: t('输入') },
]
const WEB_GROUPS: { id: WidgetGroup; label: string }[] = [{ id: 'web', label: t('网页控件') }]
/** 网页 UI 的设计根控件是 Frame：按根控件判断这棵树用哪套控件 */
const kindOf = (root: Widget) => (isWebType(root.Type) ? 'web' : 'game')
const groupsFor = (kind: 'game' | 'web') => (kind === 'web' ? WEB_GROUPS : GROUPS)

/** 控件面板：点一个控件加到选中的容器里（选中的不是容器就加到它旁边） */
export function Palette({
  components,
  onAdd,
  kind = 'game',
}: {
  kind?: 'game' | 'web'
  components: string[]
  onAdd: (type: WidgetType, cls?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const add = (type: WidgetType, cls?: string) => {
    onAdd(type, cls)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton icon={Plus} label={t('添加控件')} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] p-1.5">
        {groupsFor(kind).map((g) => (
          <div key={g.id} className="mb-1">
            <p className="px-2 pt-1.5 pb-1 text-caption text-subtle">{g.label}</p>
            <div className="grid grid-cols-2 gap-px">
              {typesFor(kind)
                .filter((x) => WIDGETS[x].group === g.id)
                .map((x) => {
                  const Icon = WIDGET_ICON[x]
                  return (
                    <button
                      key={x}
                      onClick={() => add(x)}
                      title={WIDGETS[x].hint}
                      className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-footnote text-muted hover:bg-sel hover:text-fg"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                      <span className="truncate">{x}</span>
                    </button>
                  )
                })}
            </div>
          </div>
        ))}
        {components.length > 0 && (
          <div>
            <p className="px-2 pt-1.5 pb-1 text-caption text-subtle">{t('子控件')}</p>
            {components.map((c) => (
              <button
                key={c}
                onClick={() => add('UserWidget', c)}
                className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-footnote text-muted hover:bg-sel hover:text-fg"
              >
                <Puzzle className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="truncate">{c}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export interface TreeActions {
  select: (id: string) => void
  rename: (id: string, name: string) => void
  move: (id: string, parentId: string, index: number) => void
  remove: (id: string) => void
  duplicate: (id: string) => void
  toggleVisible: (id: string) => void
  extract: (id: string) => void
  copy: (id: string) => void
  cut: (id: string) => void
  /** 粘贴到 id 里面（它放得下时），否则粘到它后面 */
  paste: (id: string) => void
  canPaste: boolean
  addChild: (parentId: string, type: WidgetType, cls?: string) => void
  wrap: (id: string, type: WidgetType) => void
  replace: (id: string, type: WidgetType) => void
  /** 可以引用的子控件（UserWidget） */
  components: string[]
}

/** 控件树（Hierarchy）：缩进显示父子关系，拖动调整顺序或换父控件，右键复制、删除、提取成子控件 */
export function Hierarchy({
  root,
  selected,
  actions,
  extra = [],
  onPick,
  renameRequest,
}: {
  root: Widget
  selected: string
  actions: WidgetMenuActions
  /** 按住 Shift / Ctrl 多选的其他控件 */
  extra?: string[]
  /** 按住 Shift / Ctrl 点：加进多选或去掉 */
  onPick?: (id: string) => void
  /** 在画布右键「重命名」：让树里这一行进入改名状态 */
  renameRequest?: { id: string; at: number }
}) {
  const kind = kindOf(root)
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState('')
  useEffect(() => {
    if (renameRequest) setRenaming(renameRequest.id)
  }, [renameRequest])
  const [drag, setDrag] = useState('')
  const [drop, setDrop] = useState<{ id: string; where: 'before' | 'after' | 'into' } | null>(null)
  // 选中的控件的上级都要展开
  const open = new Set(pathTo(root, selected).map((w) => w.id))
  const box = useRef<HTMLDivElement>(null)
  // 在树里点的不用滚；在画布上点的，把那一行滚到可见区域中间
  const fromTree = useRef('')
  useEffect(() => {
    const hit = fromTree.current === selected
    fromTree.current = ''
    if (hit) return
    const row = box.current?.querySelector<HTMLElement>(`[data-tid="${CSS.escape(selected)}"]`)
    let sc = row?.parentElement
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement
    if (!row || !sc) return
    const r = row.getBoundingClientRect()
    const b = sc.getBoundingClientRect()
    if (r.top >= b.top + 24 && r.bottom <= b.bottom - 24) return
    sc.scrollTo({ top: sc.scrollTop + r.top - b.top - (b.height - r.height) / 2, behavior: 'smooth' })
  }, [selected])

  const rows: { w: Widget; depth: number; parent?: Widget; index: number }[] = []
  const walk = (w: Widget, depth: number, parent?: Widget, index = 0) => {
    rows.push({ w, depth, parent, index })
    if (w.Children?.length && (!folded.has(w.id) || open.has(w.id)))
      w.Children.forEach((c, i) => walk(c, depth + 1, w, i))
  }
  walk(root, 0)

  const onDrop = () => {
    if (!drag || !drop) return
    const target = rows.find((r) => r.w.id === drop.id)
    if (!target) return
    if (drop.where === 'into') actions.move(drag, target.w.id, target.w.Children?.length ?? 0)
    else if (target.parent) actions.move(drag, target.parent.id, target.index + (drop.where === 'after' ? 1 : 0))
  }

  return (
    <div
      ref={box}
      role="tree"
      aria-label={t('控件树')}
      className="flex flex-col py-1"
      onPointerDownCapture={(e) =>
        (fromTree.current = (e.target as HTMLElement).closest<HTMLElement>('[data-tid]')?.dataset.tid ?? '')
      }
      onDragEnd={() => (setDrag(''), setDrop(null))}
    >
      {rows.map(({ w, depth, parent }) => {
        const Icon = WIDGET_ICON[w.Type] ?? Square
        const hasKids = !!w.Children?.length
        const isOpen = !folded.has(w.id) || open.has(w.id)
        const hidden = isHiddenVisibility(w.Properties?.Visibility)
        const locked = !!w.Properties?.Locked
        const on = w.id === selected
        const d = drop?.id === w.id ? drop.where : undefined
        return (
          <ContextMenu key={w.id}>
            <ContextMenuTrigger asChild>
              <div
                role="treeitem"
                data-tid={w.id}
                aria-selected={on}
                aria-expanded={hasKids ? isOpen : undefined}
                draggable={!!parent && renaming !== w.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', w.id)
                  setDrag(w.id)
                }}
                onDragOver={(e) => {
                  if (!drag || drag === w.id) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const y = (e.clientY - r.top) / r.height
                  const into = isPanel(w.Type) && canAddChild(w)
                  const where = !parent
                    ? 'into'
                    : into
                      ? y < 0.25
                        ? 'before'
                        : y > 0.75
                          ? 'after'
                          : 'into'
                      : y < 0.5
                        ? 'before'
                        : 'after'
                  if (where === 'into' && !into) return setDrop(null)
                  setDrop({ id: w.id, where })
                }}
                onDragLeave={() => setDrop((x) => (x?.id === w.id ? null : x))}
                onDrop={(e) => {
                  e.preventDefault()
                  onDrop()
                  setDrag('')
                  setDrop(null)
                }}
                onClick={(e) =>
                  onPick && (e.shiftKey || e.ctrlKey || e.metaKey) ? onPick(w.id) : actions.select(w.id)
                }
                onDoubleClick={() => setRenaming(w.id)}
                style={{ paddingLeft: 6 + depth * 14 }}
                className={cn(
                  'group relative flex h-7 cursor-pointer items-center gap-1 pr-1.5 text-footnote select-none',
                  on
                    ? 'bg-accent-soft text-fg'
                    : extra.includes(w.id)
                      ? 'bg-accent-soft/50 text-fg'
                      : 'text-muted hover:bg-sel/60 hover:text-fg',
                  d === 'into' && 'ring-1 ring-accent ring-inset',
                  drag === w.id && 'opacity-40',
                )}
              >
                {d === 'before' && <span className="absolute inset-x-1 top-0 h-0.5 rounded-sm bg-accent" />}
                {d === 'after' && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-sm bg-accent" />}
                <button
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    setFolded((f) => {
                      const n = new Set(f)
                      if (!n.delete(w.id)) n.add(w.id)
                      return n
                    })
                  }}
                  className={cn(
                    'grid h-4 w-4 shrink-0 cursor-pointer place-items-center text-subtle',
                    !hasKids && 'invisible',
                  )}
                  aria-label={isOpen ? t('收起') : t('展开')}
                >
                  <ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
                </button>
                <Icon className={cn('h-3.5 w-3.5 shrink-0', on ? 'text-accent-text' : 'text-subtle')} />
                {renaming === w.id ? (
                  <InlineRename
                    size="sm"
                    value={w.Name}
                    label={t('控件名')}
                    onCommit={(v) => {
                      setRenaming('')
                      if (v.trim() && v !== w.Name) actions.rename(w.id, v.trim())
                    }}
                    onCancel={() => setRenaming('')}
                    // 控件树的行很矮，改名框跟着压到行高
                    className="h-5 flex-1 rounded-sm px-1 font-mono text-footnote"
                  />
                ) : (
                  <span className={cn('min-w-0 flex-1 truncate', hidden && 'opacity-50')}>
                    {w.Name}
                    {w.Type === 'UserWidget' && w.Class && (
                      <span className="ml-1.5 text-caption text-subtle">{w.Class}</span>
                    )}
                    {WIDGETS[w.Type]?.entries && (
                      <span
                        className="ml-1.5 text-caption text-subtle"
                        title={
                          w.Type === 'UniformGridPanel'
                            ? t('格子在属性里设置，导出到 UE 时展开成子控件')
                            : t('条目在游戏运行时按数据生成，设计器里只是预览')
                        }
                      >
                        {w.Properties?.EntryWidgetClass || t('未选条目')} ×{entryCount(w)}
                      </span>
                    )}
                  </span>
                )}
                {locked && <Lock aria-label={t('已锁定')} className="h-3 w-3 shrink-0 text-subtle" />}
                {parent && (
                  <IconButton
                    icon={hidden ? EyeOff : Eye}
                    size="2xs"
                    tabIndex={-1}
                    label={hidden ? t('显示') : t('隐藏')}
                    // 隐藏了的控件一直露出眼睛，方便再点开
                    reveal={hidden ? undefined : 'hover'}
                    onClick={(e) => {
                      e.stopPropagation()
                      actions.toggleVisible(w.id)
                    }}
                  />
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <WidgetMenuItems w={w} root={root} actions={actions} kind={kind} onRename={() => setRenaming(w.id)} />
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
