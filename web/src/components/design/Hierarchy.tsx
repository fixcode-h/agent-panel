import { useState } from 'react'
import {
  BatteryMedium,
  ChevronRight,
  Columns3,
  Copy,
  Expand,
  Eye,
  EyeOff,
  Frame,
  GalleryHorizontal,
  Grid3x3,
  Image as ImageIcon,
  Layers,
  PackagePlus,
  Plus,
  Puzzle,
  RectangleHorizontal,
  Rows3,
  Scaling,
  ScrollText,
  SlidersHorizontal,
  Space,
  Square,
  SquareCheck,
  TextCursorInput,
  Trash2,
  Type,
  WrapText,
  type LucideIcon,
} from 'lucide-react'
import {
  WIDGETS,
  WIDGET_TYPES,
  canAddChild,
  isPanel,
  pathTo,
  type Widget,
  type WidgetGroup,
  type WidgetType,
} from '@shared/umg'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/menu'
import { t } from '@shared/i18n'

export const WIDGET_ICON: Record<WidgetType, LucideIcon> = {
  CanvasPanel: Frame,
  Overlay: Layers,
  HorizontalBox: Columns3,
  VerticalBox: Rows3,
  UniformGridPanel: Grid3x3,
  WrapBox: WrapText,
  ScrollBox: ScrollText,
  SizeBox: Scaling,
  ScaleBox: Expand,
  Border: Square,
  WidgetSwitcher: GalleryHorizontal,
  Spacer: Space,
  Image: ImageIcon,
  TextBlock: Type,
  Button: RectangleHorizontal,
  CheckBox: SquareCheck,
  ProgressBar: BatteryMedium,
  Slider: SlidersHorizontal,
  EditableTextBox: TextCursorInput,
  UserWidget: Puzzle,
}

const GROUPS: { id: WidgetGroup; label: string }[] = [
  { id: 'panel', label: t('面板') },
  { id: 'common', label: t('常用') },
  { id: 'input', label: t('输入') },
]

/** 控件面板：点一个控件加到选中的容器里（选中的不是容器就加到它旁边） */
export function Palette({
  components,
  onAdd,
}: {
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
        <button
          aria-label={t('添加控件')}
          title={t('添加控件')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] p-1.5">
        {GROUPS.map((g) => (
          <div key={g.id} className="mb-1">
            <p className="px-2 pt-1.5 pb-1 text-[11px] text-subtle">{g.label}</p>
            <div className="grid grid-cols-2 gap-px">
              {WIDGET_TYPES.filter((x) => WIDGETS[x].group === g.id).map((x) => {
                const Icon = WIDGET_ICON[x]
                return (
                  <button
                    key={x}
                    onClick={() => add(x)}
                    title={WIDGETS[x].hint}
                    className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted hover:bg-sel hover:text-fg"
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
            <p className="px-2 pt-1.5 pb-1 text-[11px] text-subtle">{t('子控件')}</p>
            {components.map((c) => (
              <button
                key={c}
                onClick={() => add('UserWidget', c)}
                className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted hover:bg-sel hover:text-fg"
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
}

/** 控件树（Hierarchy）：缩进显示父子关系，拖动调整顺序或换父控件，右键复制、删除、提取成子控件 */
export function Hierarchy({ root, selected, actions }: { root: Widget; selected: string; actions: TreeActions }) {
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState('')
  const [drag, setDrag] = useState('')
  const [drop, setDrop] = useState<{ id: string; where: 'before' | 'after' | 'into' } | null>(null)
  // 选中的控件的上级都要展开
  const open = new Set(pathTo(root, selected).map((w) => w.id))

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
      role="tree"
      aria-label={t('控件树')}
      className="flex flex-col py-1"
      onDragEnd={() => (setDrag(''), setDrop(null))}
    >
      {rows.map(({ w, depth, parent }) => {
        const Icon = WIDGET_ICON[w.Type] ?? Square
        const hasKids = !!w.Children?.length
        const isOpen = !folded.has(w.id) || open.has(w.id)
        const hidden = w.Properties?.Visibility === 'Collapsed' || w.Properties?.Visibility === 'Hidden'
        const on = w.id === selected
        const d = drop?.id === w.id ? drop.where : undefined
        return (
          <ContextMenu key={w.id}>
            <ContextMenuTrigger asChild>
              <div
                role="treeitem"
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
                onClick={() => actions.select(w.id)}
                onDoubleClick={() => setRenaming(w.id)}
                style={{ paddingLeft: 6 + depth * 14 }}
                className={cn(
                  'group relative flex h-7 cursor-pointer items-center gap-1 pr-1.5 text-[12.5px] select-none',
                  on ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sel/60 hover:text-fg',
                  d === 'into' && 'ring-1 ring-accent ring-inset',
                  drag === w.id && 'opacity-40',
                )}
              >
                {d === 'before' && <span className="absolute inset-x-1 top-0 h-0.5 rounded bg-accent" />}
                {d === 'after' && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded bg-accent" />}
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
                <Icon className={cn('h-3.5 w-3.5 shrink-0', on ? 'text-accent' : 'text-subtle')} />
                {renaming === w.id ? (
                  <input
                    autoFocus
                    defaultValue={w.Name}
                    aria-label={t('控件名')}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      setRenaming('')
                      if (e.target.value.trim() && e.target.value !== w.Name)
                        actions.rename(w.id, e.target.value.trim())
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setRenaming('')
                      }
                    }}
                    className="h-5 min-w-0 flex-1 rounded border border-accent bg-field px-1 font-mono text-[12px] outline-none"
                  />
                ) : (
                  <span className={cn('min-w-0 flex-1 truncate', hidden && 'opacity-50')}>
                    {w.Name}
                    {w.Type === 'UserWidget' && w.Class && (
                      <span className="ml-1.5 text-[11px] text-subtle">{w.Class}</span>
                    )}
                  </span>
                )}
                {parent && (
                  <button
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      actions.toggleVisible(w.id)
                    }}
                    aria-label={hidden ? t('显示') : t('隐藏')}
                    title={hidden ? t('显示') : t('隐藏')}
                    className={cn(
                      'grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:text-fg',
                      !hidden && 'opacity-0 group-hover:opacity-100',
                    )}
                  >
                    {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => setRenaming(w.id)}>{t('重命名')}</ContextMenuItem>
              {parent && (
                <ContextMenuItem onSelect={() => actions.duplicate(w.id)}>
                  <Copy className="h-4 w-4" />
                  {t('复制一份')}
                </ContextMenuItem>
              )}
              {parent && w.Type !== 'UserWidget' && (
                <ContextMenuItem onSelect={() => actions.extract(w.id)}>
                  <PackagePlus className="h-4 w-4" />
                  {t('提取成子控件')}
                </ContextMenuItem>
              )}
              {parent && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem danger onSelect={() => actions.remove(w.id)}>
                    <Trash2 className="h-4 w-4" />
                    {t('删除')}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
