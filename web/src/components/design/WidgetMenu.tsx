import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  BatteryMedium,
  BoxSelect,
  CaseSensitive,
  ClipboardPaste,
  Columns3,
  Copy,
  CopyPlus,
  CornerLeftUp,
  Expand,
  Eye,
  EyeOff,
  Frame,
  GalleryHorizontal,
  Grid3x3,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  List,
  ListPlus,
  Lock,
  MousePointerClick,
  PackagePlus,
  PencilLine,
  Plus,
  Puzzle,
  Quote,
  RectangleHorizontal,
  Replace,
  Rows3,
  Scaling,
  Scissors,
  ScrollText,
  SeparatorHorizontal,
  SlidersHorizontal,
  Space,
  Square,
  SquareCheck,
  SquareDashed,
  TextCursorInput,
  Trash2,
  Type,
  Unlock,
  WrapText,
  type LucideIcon,
} from 'lucide-react'
import {
  WIDGETS,
  canAddChild,
  canReplace,
  findParent,
  isPanel,
  typesFor,
  type Widget,
  type WidgetGroup,
  type WidgetType,
} from '@shared/umg'
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  MenuShortcut,
} from '@/components/ui/menu'
import { t } from '@shared/i18n'
import type { TreeActions } from './Hierarchy'

/** 控件类型对应的图标：控件树、控件面板和右键菜单共用 */
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
  ListView: List,
  TileView: LayoutGrid,
  DynamicEntryBox: ListPlus,
  Spacer: Space,
  Image: ImageIcon,
  TextBlock: Type,
  Button: RectangleHorizontal,
  CheckBox: SquareCheck,
  ProgressBar: BatteryMedium,
  Slider: SlidersHorizontal,
  EditableTextBox: TextCursorInput,
  UserWidget: Puzzle,
  Frame: SquareDashed,
  Text: CaseSensitive,
  Picture: ImageIcon,
  WebButton: MousePointerClick,
  Input: TextCursorInput,
  Divider: SeparatorHorizontal,
}

export type WidgetLayer = 'top' | 'bottom' | 'up' | 'down'
export type WidgetAlign = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** 画布和控件树共用的控件菜单动作：除了树里原有的，还有锁定、层级和引用 */
export interface WidgetMenuActions extends TreeActions {
  lock: (id: string) => void
  layer: (id: string, how: WidgetLayer) => void
  cite: (id: string) => void
}

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'
const groups: { id: WidgetGroup; label: string }[] = [
  { id: 'panel', label: t('面板') },
  { id: 'list', label: t('列表（运行时生成）') },
  { id: 'common', label: t('常用') },
  { id: 'input', label: t('输入') },
]
const webGroups: { id: WidgetGroup; label: string }[] = [{ id: 'web', label: t('网页控件') }]
const groupsFor = (kind: 'game' | 'web') => (kind === 'web' ? webGroups : groups)
const panelsFor = (kind: 'game' | 'web') =>
  typesFor(kind).filter((x) => (WIDGETS[x].group === 'panel' || WIDGETS[x].group === 'web') && isPanel(x))

function TypeItem({ type, onSelect }: { type: WidgetType; onSelect: () => void }) {
  const Icon = WIDGET_ICON[type]
  return (
    <ContextMenuItem onSelect={onSelect} title={WIDGETS[type].hint}>
      <Icon className="h-4 w-4 text-subtle" />
      {type}
    </ContextMenuItem>
  )
}

/**
 * 一个控件的右键菜单内容：画布和控件树共用，保证两边的功能、顺序和样式一致。
 * onRename 由页面接管（控件树里就地改名）；align 只在画布里有（按量到的位置对齐）。
 */
export function WidgetMenuItems({
  w,
  root,
  actions,
  kind,
  onRename,
  align,
}: {
  w: Widget
  root: Widget
  actions: WidgetMenuActions
  kind: 'game' | 'web'
  onRename: () => void
  /** 多选（或单个对父控件）对齐；不传就不显示对齐菜单 */
  align?: { run: (how: WidgetAlign) => void; enabled: boolean }
}) {
  const parent = findParent(root, w.id)
  const index = parent?.Children?.findIndex((c) => c.id === w.id) ?? -1
  const hidden = w.Properties?.Visibility === 'Collapsed' || w.Properties?.Visibility === 'Hidden'
  const locked = !!w.Properties?.Locked
  const canvas = parent?.Type === 'CanvasPanel' && !!w.Slot
  const zs = parent?.Children?.map((c) => Number(c.Slot?.ZOrder) || 0) ?? []
  const z = Number(w.Slot?.ZOrder) || 0
  const canLayerUp = canvas ? z < Math.max(...zs) : index > 0
  const canLayerDown = canvas ? z > Math.min(...zs) : index >= 0 && index < (parent?.Children?.length ?? 1) - 1

  return (
    <>
      <ContextMenuItem onSelect={onRename}>
        <PencilLine className="h-4 w-4" />
        {t('重命名')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.cite(w.id)}>
        <Quote className="h-4 w-4" />
        {t('引用到 AI 对话')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {parent && (
        <ContextMenuItem onSelect={() => actions.cut(w.id)}>
          <Scissors className="h-4 w-4" />
          {t('剪切')}
          <MenuShortcut>{MOD}X</MenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => actions.copy(w.id)}>
        <Copy className="h-4 w-4" />
        {t('复制')}
        <MenuShortcut>{MOD}C</MenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!actions.canPaste || (!parent && !canAddChild(w))}
        onSelect={() => actions.paste(w.id)}
      >
        <ClipboardPaste className="h-4 w-4" />
        {canAddChild(w) ? t('粘贴到里面') : t('粘贴到后面')}
        <MenuShortcut>{MOD}V</MenuShortcut>
      </ContextMenuItem>
      {parent && (
        <ContextMenuItem disabled={WIDGETS[parent.Type].children !== 'many'} onSelect={() => actions.duplicate(w.id)}>
          <CopyPlus className="h-4 w-4" />
          {t('创建副本')}
          <MenuShortcut>{MOD}D</MenuShortcut>
        </ContextMenuItem>
      )}
      {parent && (
        <ContextMenuItem onSelect={() => actions.toggleVisible(w.id)}>
          {hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {hidden ? t('显示') : t('隐藏')}
        </ContextMenuItem>
      )}
      {parent && (
        <ContextMenuItem onSelect={() => actions.lock(w.id)}>
          {locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          {locked ? t('解锁') : t('锁定')}
        </ContextMenuItem>
      )}
      {parent && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ArrowUpToLine className="h-4 w-4" />
            {t('层级')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem disabled={!canLayerUp} onSelect={() => actions.layer(w.id, 'top')}>
              <ArrowUpToLine className="h-4 w-4" />
              {t('置顶')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!canLayerUp} onSelect={() => actions.layer(w.id, 'up')}>
              <ArrowUp className="h-4 w-4" />
              {t('上移一层')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!canLayerDown} onSelect={() => actions.layer(w.id, 'down')}>
              <ArrowDown className="h-4 w-4" />
              {t('下移一层')}
            </ContextMenuItem>
            <ContextMenuItem disabled={!canLayerDown} onSelect={() => actions.layer(w.id, 'bottom')}>
              <ArrowDownToLine className="h-4 w-4" />
              {t('置底')}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {align && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <BoxSelect className="h-4 w-4" />
            {t('对齐')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {(
              [
                ['left', t('左对齐')],
                ['hcenter', t('水平居中')],
                ['right', t('右对齐')],
                ['top', t('顶对齐')],
                ['vcenter', t('垂直居中')],
                ['bottom', t('底对齐')],
              ] as const
            ).map(([how, label]) => (
              <ContextMenuItem key={how} disabled={!align.enabled} onSelect={() => align.run(how)}>
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      {canAddChild(w) && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Plus className="h-4 w-4" />
            {t('添加子控件')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {groupsFor(kind).map((g) => (
              <div key={g.id}>
                <ContextMenuLabel>{g.label}</ContextMenuLabel>
                {typesFor(kind)
                  .filter((x) => WIDGETS[x].group === g.id)
                  .map((x) => (
                    <TypeItem key={x} type={x} onSelect={() => actions.addChild(w.id, x)} />
                  ))}
              </div>
            ))}
            {actions.components.length > 0 && (
              <>
                <ContextMenuLabel>{t('子控件')}</ContextMenuLabel>
                {actions.components.map((c) => (
                  <ContextMenuItem key={c} onSelect={() => actions.addChild(w.id, 'UserWidget', c)}>
                    <Puzzle className="h-4 w-4 text-subtle" />
                    {c}
                  </ContextMenuItem>
                ))}
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <BoxSelect className="h-4 w-4" />
          {t('包裹为')}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {panelsFor(kind).map((x) => (
            <TypeItem key={x} type={x} onSelect={() => actions.wrap(w.id, x)} />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {w.Type !== 'UserWidget' && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Replace className="h-4 w-4" />
            {t('替换为')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {typesFor(kind)
              .filter((x) => canReplace(w, x) && (isPanel(w.Type) === isPanel(x) || !w.Children?.length))
              .map((x) => (
                <TypeItem key={x} type={x} onSelect={() => actions.replace(w.id, x)} />
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {parent && (
        <ContextMenuItem onSelect={() => actions.select(parent.id)}>
          <CornerLeftUp className="h-4 w-4" />
          {t('选中父控件')}
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
            <MenuShortcut>Del</MenuShortcut>
          </ContextMenuItem>
        </>
      )}
    </>
  )
}
