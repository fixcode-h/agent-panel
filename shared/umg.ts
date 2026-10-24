import { exportAnimations, type UiAnimation } from './anim.ts'
/**
 * 游戏 UI 设计用的 UMG 控件模型。面板里保存的结构和导出的结构是同一套：
 * 控件类型、插槽、属性名都按 UE5 的 UMG 来写（CanvasPanelSlot.LayoutData.Offsets、Brush.DrawAs、Font.Size……），
 * 导出时只去掉面板内部用的 id、把图片引用换成贴图名、颜色换成 UE 的 LinearColor，导入工具照着名字一一对上即可。
 *
 * 颜色在面板里存成 sRGB 的 #RRGGBBAA（好编辑、AI 也好写），导出时同时给出 LinearColor 和 Hex。
 * 图片引用在面板里写成 Brush.ResourceObject = "img:<图片 id>"。
 */

export type Vec2 = { X: number; Y: number }
export type Margin = { Left: number; Top: number; Right: number; Bottom: number }
export type HAlign = 'HAlign_Fill' | 'HAlign_Left' | 'HAlign_Center' | 'HAlign_Right'
export type VAlign = 'VAlign_Fill' | 'VAlign_Top' | 'VAlign_Center' | 'VAlign_Bottom'

export interface Brush {
  /** "img:<id>" 指向设计里的图片；为空时按 UE 的白色画刷画，颜色取 TintColor */
  ResourceObject: string
  ImageSize: Vec2
  /** Image 直接拉伸；Box 按 Margin 九宫格；Border 只画边框；RoundedBox 圆角矩形；NoDrawType 不画 */
  DrawAs: 'Image' | 'Box' | 'Border' | 'RoundedBox' | 'NoDrawType'
  /** 九宫格的边距，按图片尺寸的比例（0~1），和 UE 一样 */
  Margin: Margin
  Tiling: 'NoTile' | 'Horizontal' | 'Vertical' | 'Both'
  TintColor: string
  /** DrawAs 为 RoundedBox 时的圆角 */
  OutlineSettings?: { CornerRadii: { X: number; Y: number; Z: number; W: number }; Color: string; Width: number }
}

export interface Widget {
  /** 面板内部用来选中、拖动的 id，导出时去掉 */
  id: string
  Type: WidgetType
  Name: string
  /** 放在父控件里的插槽属性；根控件没有 */
  Slot?: Record<string, any>
  Properties: Record<string, any>
  Children?: Widget[]
  /** UserWidget 引用的子控件名 */
  Class?: string
}

export interface Component {
  Name: string
  DesignSize: Vec2
  Root: Widget
}

export type ChildRule = 'many' | 'one' | 'none'
export type WidgetGroup = 'panel' | 'list' | 'common' | 'input' | 'user' | 'web'

export const WIDGET_TYPES = [
  'CanvasPanel',
  'Overlay',
  'HorizontalBox',
  'VerticalBox',
  'UniformGridPanel',
  'WrapBox',
  'ScrollBox',
  'SizeBox',
  'ScaleBox',
  'Border',
  'WidgetSwitcher',
  'ListView',
  'TileView',
  'DynamicEntryBox',
  'Spacer',
  'Image',
  'TextBlock',
  'Button',
  'CheckBox',
  'ProgressBar',
  'Slider',
  'EditableTextBox',
  'UserWidget',
  // 网页 UI 用的控件（WEB_TYPES），和 UMG 的分开列
  'Frame',
  'Text',
  'Picture',
  'WebButton',
  'Input',
  'Divider',
] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

export const color = (hex: string) => hex
export const brush = (o: Partial<Brush> = {}): Brush => ({
  ResourceObject: '',
  ImageSize: { X: 32, Y: 32 },
  DrawAs: 'Image',
  Margin: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
  Tiling: 'NoTile',
  TintColor: '#FFFFFFFF',
  ...o,
})
const margin = (v = 0): Margin => ({ Left: v, Top: v, Right: v, Bottom: v })

export interface WidgetDef {
  type: WidgetType
  group: WidgetGroup
  children: ChildRule
  /** 放进这个控件的子控件用哪种插槽 */
  slot?: SlotType
  /** 新建时的属性 */
  defaults: () => Record<string, any>
  /** 给 AI 的一句话说明 */
  hint: string
  /**
   * 运行时才填内容的列表（ListView、TileView、DynamicEntryBox）：设计时不放子控件，
   * 条目用 EntryWidgetClass 指定的子控件，设计器里按 NumDesignerPreviewEntries 预览几条。
   * UniformGridPanel 也这样设：格子都是同一个子控件，在属性里设格子数和列数，导出时展开成 UE 里真正的子控件
   */
  entries?: boolean
}

export type SlotType =
  | 'CanvasPanelSlot'
  | 'OverlaySlot'
  | 'HorizontalBoxSlot'
  | 'VerticalBoxSlot'
  | 'UniformGridSlot'
  | 'WrapBoxSlot'
  | 'ScrollBoxSlot'
  | 'SizeBoxSlot'
  | 'ScaleBoxSlot'
  | 'BorderSlot'
  | 'ButtonSlot'
  | 'CheckBoxSlot'
  | 'WidgetSwitcherSlot'
  | 'FlexSlot'

const W = (
  type: WidgetType,
  group: WidgetGroup,
  children: ChildRule,
  slot: SlotType | undefined,
  hint: string,
  defaults: () => Record<string, any> = () => ({}),
): WidgetDef => ({ type, group, children, slot, defaults, hint })

/** UE 自带的常用控件；属性名、取值和 UE5 一致 */
export const WIDGETS: Record<WidgetType, WidgetDef> = {
  CanvasPanel: W('CanvasPanel', 'panel', 'many', 'CanvasPanelSlot', '自由摆放：子控件用锚点 + 偏移定位，适合做根节点'),
  Overlay: W('Overlay', 'panel', 'many', 'OverlaySlot', '叠放：子控件一层层叠在一起，按对齐方式摆放'),
  HorizontalBox: W('HorizontalBox', 'panel', 'many', 'HorizontalBoxSlot', '横向排列'),
  VerticalBox: W('VerticalBox', 'panel', 'many', 'VerticalBoxSlot', '纵向排列'),
  UniformGridPanel: {
    ...W(
      'UniformGridPanel',
      'panel',
      'none',
      'UniformGridSlot',
      '等大网格，格子数量设计时就固定（技能栏、快捷栏）：不放子控件，EntryWidgetClass 指定每个格子用的子控件，NumEntries 是格子数、NumColumns 是每行几个，SlotPadding 是格子间距；运行时才知道数量的背包格子用 TileView',
      () => ({
        EntryWidgetClass: '',
        NumEntries: 9,
        NumColumns: 3,
        SlotPadding: margin(0),
        MinDesiredSlotWidth: 0,
        MinDesiredSlotHeight: 0,
        EntryHorizontalAlignment: 'HAlign_Fill',
        EntryVerticalAlignment: 'VAlign_Fill',
      }),
    ),
    entries: true,
  },
  WrapBox: W('WrapBox', 'panel', 'many', 'WrapBoxSlot', '自动换行排列', () => ({
    InnerSlotPadding: { X: 0, Y: 0 },
    Orientation: 'Orient_Horizontal',
  })),
  ScrollBox: W('ScrollBox', 'panel', 'many', 'ScrollBoxSlot', '可滚动的列表', () => ({
    Orientation: 'Orient_Vertical',
    ScrollBarVisibility: 'Visible',
  })),
  SizeBox: W('SizeBox', 'panel', 'one', 'SizeBoxSlot', '固定或限制子控件的宽高', () => ({
    WidthOverride: 0,
    HeightOverride: 0,
    MinDesiredWidth: 0,
    MinDesiredHeight: 0,
    MaxDesiredWidth: 0,
    MaxDesiredHeight: 0,
  })),
  ScaleBox: W('ScaleBox', 'panel', 'one', 'ScaleBoxSlot', '按比例缩放子控件', () => ({
    Stretch: 'ScaleToFit',
    StretchDirection: 'Both',
  })),
  Border: W('Border', 'panel', 'one', 'BorderSlot', '带背景图的容器（面板底图、九宫格框）', () => ({
    Background: brush({ DrawAs: 'Box' }),
    BrushColor: '#FFFFFFFF',
    ContentColorAndOpacity: '#FFFFFFFF',
  })),
  WidgetSwitcher: W('WidgetSwitcher', 'panel', 'many', 'WidgetSwitcherSlot', '多页切换，只显示一个子控件', () => ({
    ActiveWidgetIndex: 0,
  })),
  ListView: {
    ...W(
      'ListView',
      'list',
      'none',
      undefined,
      '运行时按数据生成条目的滚动列表（任务、邮件、排行榜）：不放子控件，EntryWidgetClass 指定条目用的子控件',
      () => ({
        EntryWidgetClass: '',
        NumDesignerPreviewEntries: 5,
        Orientation: 'Orient_Vertical',
        EntrySpacing: 0,
        SelectionMode: 'Single',
      }),
    ),
    entries: true,
  },
  TileView: {
    ...W(
      'TileView',
      'list',
      'none',
      undefined,
      '运行时按数据生成的等大格子（背包、商店、图鉴）：不放子控件，EntryWidgetClass 指定格子用的子控件，EntryWidth / EntryHeight 是格子大小',
      () => ({
        EntryWidgetClass: '',
        NumDesignerPreviewEntries: 12,
        Orientation: 'Orient_Vertical',
        EntryWidth: 128,
        EntryHeight: 128,
        TileAlignment: 'EvenlyDistributed',
        SelectionMode: 'Single',
      }),
    ),
    entries: true,
  },
  DynamicEntryBox: {
    ...W(
      'DynamicEntryBox',
      'list',
      'none',
      undefined,
      '运行时生成数量不定、不需要滚动的条目（Buff 图标、星级、页签）：不放子控件，EntryWidgetClass 指定条目用的子控件',
      () => ({
        EntryWidgetClass: '',
        NumDesignerPreviewEntries: 3,
        EntryBoxType: 'Horizontal',
        EntrySpacing: { X: 0, Y: 0 },
        EntryHorizontalAlignment: 'HAlign_Fill',
        EntryVerticalAlignment: 'VAlign_Fill',
      }),
    ),
    entries: true,
  },
  Spacer: W('Spacer', 'panel', 'none', undefined, '占位留空', () => ({ Size: { X: 16, Y: 16 } })),
  Image: W('Image', 'common', 'none', undefined, '显示一张图片（图标、高亮框、装饰）', () => ({
    Brush: brush(),
    ColorAndOpacity: '#FFFFFFFF',
  })),
  TextBlock: W('TextBlock', 'common', 'none', undefined, '文字', () => ({
    Text: 'Text Block',
    Font: {
      TypefaceFontName: 'Regular',
      Size: 24,
      LetterSpacing: 0,
      OutlineSettings: { OutlineSize: 0, OutlineColor: '#000000FF' },
    },
    ColorAndOpacity: '#FFFFFFFF',
    ShadowOffset: { X: 1, Y: 1 },
    ShadowColorAndOpacity: '#00000000',
    Justification: 'Left',
    AutoWrapText: false,
  })),
  Button: W('Button', 'common', 'one', 'ButtonSlot', '按钮：四种状态各一张图，里面可以放文字或图标', () => ({
    WidgetStyle: {
      Normal: brush({ DrawAs: 'Box', TintColor: '#3A3A3AFF' }),
      Hovered: brush({ DrawAs: 'Box', TintColor: '#4A4A4AFF' }),
      Pressed: brush({ DrawAs: 'Box', TintColor: '#2A2A2AFF' }),
      Disabled: brush({ DrawAs: 'Box', TintColor: '#2A2A2A80' }),
      NormalPadding: { Left: 12, Top: 2, Right: 12, Bottom: 2 },
      PressedPadding: { Left: 12, Top: 3, Right: 12, Bottom: 1 },
    },
    ColorAndOpacity: '#FFFFFFFF',
    BackgroundColor: '#FFFFFFFF',
    IsFocusable: true,
  })),
  CheckBox: W('CheckBox', 'input', 'one', 'CheckBoxSlot', '勾选框 / 开关', () => ({
    CheckedState: 'Unchecked',
    WidgetStyle: {
      UncheckedImage: brush({ ImageSize: { X: 24, Y: 24 }, TintColor: '#5A5A5AFF' }),
      CheckedImage: brush({ ImageSize: { X: 24, Y: 24 }, TintColor: '#D97757FF' }),
    },
  })),
  ProgressBar: W('ProgressBar', 'common', 'none', undefined, '进度条 / 血条', () => ({
    Percent: 0.6,
    BarFillType: 'LeftToRight',
    WidgetStyle: {
      BackgroundImage: brush({ DrawAs: 'Box', TintColor: '#202020FF' }),
      FillImage: brush({ DrawAs: 'Box', TintColor: '#D97757FF' }),
    },
    FillColorAndOpacity: '#FFFFFFFF',
  })),
  Slider: W('Slider', 'input', 'none', undefined, '滑动条', () => ({
    Value: 0.5,
    MinValue: 0,
    MaxValue: 1,
    Orientation: 'Orient_Horizontal',
    WidgetStyle: {
      NormalBarImage: brush({ ImageSize: { X: 8, Y: 8 }, TintColor: '#404040FF' }),
      NormalThumbImage: brush({ ImageSize: { X: 16, Y: 16 }, TintColor: '#FFFFFFFF' }),
    },
    SliderBarColor: '#FFFFFFFF',
    SliderHandleColor: '#FFFFFFFF',
  })),
  EditableTextBox: W('EditableTextBox', 'input', 'none', undefined, '输入框', () => ({
    Text: '',
    HintText: 'Enter text',
    Font: { TypefaceFontName: 'Regular', Size: 18, LetterSpacing: 0 },
    WidgetStyle: { BackgroundImageNormal: brush({ DrawAs: 'Box', TintColor: '#1E1E1EFF' }) },
    ForegroundColor: '#FFFFFFFF',
  })),
  UserWidget: W('UserWidget', 'user', 'none', undefined, '引用一个子控件（Components 里定义的）'),

  // ---- 网页 UI ----
  // 布局和 Figma 的自动布局、CSS 的 flex 一样：Frame 横排或竖排子控件；每个控件的宽高是
  // "auto"（按内容）、"fill"（占满父控件剩下的空间）或像素数
  Frame: W(
    'Frame',
    'web',
    'many',
    'FlexSlot',
    '容器（div）：Direction 横排 row / 竖排 column 放子控件，Gap 间距、Padding 内边距、AlignItems 交叉轴对齐、JustifyContent 主轴分布；可设背景色、背景图、圆角、边框、阴影。页面、卡片、导航栏、列表都用它搭',
    () => ({
      Direction: 'column',
      Gap: 0,
      Padding: margin(0),
      AlignItems: 'stretch',
      JustifyContent: 'start',
      Wrap: false,
      Width: 'auto',
      Height: 'auto',
      Background: '#00000000',
      BackgroundImage: '',
      Radius: 0,
      BorderWidth: 0,
      BorderColor: '#E5E7EBFF',
      Shadow: 'none',
      Overflow: 'visible',
    }),
  ),
  Text: W('Text', 'web', 'none', undefined, '文字（标题、段落、标签）：Tag 选 h1/h2/h3/p/span', () => ({
    Text: 'Text',
    Tag: 'p',
    FontSize: 16,
    FontWeight: 400,
    Color: '#111827FF',
    TextAlign: 'left',
    LineHeight: 1.5,
    LetterSpacing: 0,
    Width: 'auto',
    Height: 'auto',
  })),
  Picture: W('Picture', 'web', 'none', undefined, '图片（img）：Src 写 "img:<图片 id>"，Fit 是缩放方式', () => ({
    Src: '',
    Fit: 'cover',
    Width: 160,
    Height: 120,
    Radius: 0,
    Alt: '',
  })),
  WebButton: W('WebButton', 'web', 'none', undefined, '按钮（button）', () => ({
    Text: 'Button',
    FontSize: 14,
    FontWeight: 500,
    Color: '#FFFFFFFF',
    Background: '#2563EBFF',
    BackgroundImage: '',
    Padding: { Left: 16, Top: 8, Right: 16, Bottom: 8 },
    Radius: 8,
    BorderWidth: 0,
    BorderColor: '#00000000',
    Width: 'auto',
    Height: 'auto',
  })),
  Input: W('Input', 'web', 'none', undefined, '输入框（input / textarea）：Multiline 为 true 时多行', () => ({
    Placeholder: '请输入',
    Value: '',
    InputType: 'text',
    Multiline: false,
    FontSize: 14,
    Color: '#111827FF',
    Background: '#FFFFFFFF',
    BorderWidth: 1,
    BorderColor: '#D1D5DBFF',
    Radius: 8,
    Padding: { Left: 12, Top: 8, Right: 12, Bottom: 8 },
    Width: 'fill',
    Height: 'auto',
  })),
  Divider: W('Divider', 'web', 'none', undefined, '分隔线：横向或竖向', () => ({
    Color: '#E5E7EBFF',
    Thickness: 1,
    Vertical: false,
  })),
}

/** 网页 UI 能用的控件（加上 UserWidget 引用子控件） */
export const WEB_TYPES: WidgetType[] = ['Frame', 'Text', 'Picture', 'WebButton', 'Input', 'Divider']
export const isWebType = (type: string) => (WEB_TYPES as string[]).includes(type)
/** 某种设计能用的控件 */
export const typesFor = (kind: 'game' | 'web'): WidgetType[] =>
  kind === 'web' ? [...WEB_TYPES, 'UserWidget'] : WIDGET_TYPES.filter((t) => !isWebType(t))
/** 网页的根控件：一个占满整页的竖排 Frame */
export const webRoot = (): Widget => ({
  ...newWidget('Frame', 'Page'),
  Properties: {
    ...COMMON_PROPS(),
    ...WIDGETS.Frame.defaults(),
    Width: 'fill',
    Height: 'fill',
    Background: '#FFFFFFFF',
  },
})

export const isPanel = (type: WidgetType) => WIDGETS[type]?.children !== 'none'
export const canAddChild = (w: Widget) =>
  WIDGETS[w.Type]?.children === 'many' || (WIDGETS[w.Type]?.children === 'one' && !(w.Children?.length ?? 0))

/** 某种插槽新建时的默认值；CanvasPanel 里新放的控件放在 (x, y)，大小 w × h */
export function defaultSlot(
  slot: SlotType | undefined,
  x = 0,
  y = 0,
  w = 100,
  h = 40,
): Record<string, any> | undefined {
  switch (slot) {
    case 'CanvasPanelSlot':
      return {
        LayoutData: {
          Offsets: { Left: x, Top: y, Right: w, Bottom: h },
          Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 0, Y: 0 } },
          Alignment: { X: 0, Y: 0 },
        },
        bAutoSize: false,
        ZOrder: 0,
      }
    case 'HorizontalBoxSlot':
    case 'VerticalBoxSlot':
      return {
        Padding: margin(0),
        Size: { SizeRule: 'Automatic', Value: 1 },
        HorizontalAlignment: 'HAlign_Fill',
        VerticalAlignment: 'VAlign_Fill',
      }
    case 'UniformGridSlot':
      return { Row: 0, Column: 0, HorizontalAlignment: 'HAlign_Fill', VerticalAlignment: 'VAlign_Fill' }
    case 'WrapBoxSlot':
      return {
        Padding: margin(0),
        bFillEmptySpace: false,
        HorizontalAlignment: 'HAlign_Fill',
        VerticalAlignment: 'VAlign_Fill',
      }
    case 'ButtonSlot':
    case 'CheckBoxSlot':
      return { Padding: margin(0), HorizontalAlignment: 'HAlign_Center', VerticalAlignment: 'VAlign_Center' }
    case 'BorderSlot':
      return { Padding: margin(4), HorizontalAlignment: 'HAlign_Fill', VerticalAlignment: 'VAlign_Fill' }
    // 网页的 Frame：子控件自己的宽高写在属性里，插槽只管在交叉轴上怎么对齐
    case 'FlexSlot':
      return { AlignSelf: 'auto' }
    case undefined:
      return undefined
    default:
      return { Padding: margin(0), HorizontalAlignment: 'HAlign_Fill', VerticalAlignment: 'VAlign_Fill' }
  }
}

/** 所有控件都有的属性 */
export const COMMON_PROPS = () => ({
  Visibility: 'Visible',
  RenderOpacity: 1,
  bIsEnabled: true,
  ToolTipText: '',
  RenderTransform: { Translation: { X: 0, Y: 0 }, Scale: { X: 1, Y: 1 }, Shear: { X: 0, Y: 0 }, Angle: 0 },
  RenderTransformPivot: { X: 0.5, Y: 0.5 },
})

export const newId = () => Math.random().toString(36).slice(2, 10)

export function newWidget(type: WidgetType, name: string, slot?: Record<string, any>): Widget {
  const def = WIDGETS[type]
  return {
    id: newId(),
    Type: type,
    Name: name,
    ...(slot ? { Slot: slot } : {}),
    Properties: { ...COMMON_PROPS(), ...def.defaults() },
    ...(def.children !== 'none' ? { Children: [] } : {}),
  }
}

// ---- 树操作：都返回新树，不改原来的（撤销、重做靠保存旧树） ----

export function walk(w: Widget, fn: (w: Widget, parent: Widget | undefined) => void, parent?: Widget) {
  fn(w, parent)
  for (const c of w.Children ?? []) walk(c, fn, w)
}

export function findWidget(root: Widget, id: string): Widget | undefined {
  let hit: Widget | undefined
  walk(root, (w) => {
    if (w.id === id) hit = w
  })
  return hit
}

export function findParent(root: Widget, id: string): Widget | undefined {
  let hit: Widget | undefined
  walk(root, (w, p) => {
    if (w.id === id) hit = p
  })
  return hit
}

/** 从根到这个控件的路径（含两端） */
export function pathTo(root: Widget, id: string): Widget[] {
  if (root.id === id) return [root]
  for (const c of root.Children ?? []) {
    const p = pathTo(c, id)
    if (p.length) return [root, ...p]
  }
  return []
}

export function mapWidget(root: Widget, id: string, fn: (w: Widget) => Widget): Widget {
  if (root.id === id) return fn(root)
  if (!root.Children) return root
  let changed = false
  const kids = root.Children.map((c) => {
    const n = mapWidget(c, id, fn)
    if (n !== c) changed = true
    return n
  })
  return changed ? { ...root, Children: kids } : root
}

export function removeWidget(root: Widget, id: string): Widget {
  if (!root.Children) return root
  const kids = root.Children.filter((c) => c.id !== id).map((c) => removeWidget(c, id))
  return { ...root, Children: kids }
}

/** 放进 parentId，index 不给时放在最后；插槽换成新父控件的类型（保留能保留的字段） */
export function insertWidget(root: Widget, parentId: string, w: Widget, index?: number): Widget {
  return mapWidget(root, parentId, (p) => {
    const kids = [...(p.Children ?? [])]
    const slot = adaptSlot(w.Slot, WIDGETS[p.Type].slot)
    kids.splice(index ?? kids.length, 0, { ...w, Slot: slot })
    return { ...p, Children: kids }
  })
}

/** 挪到别的父控件下面；不能挪进自己的子孙 */
export function moveWidget(root: Widget, id: string, parentId: string, index?: number): Widget {
  if (id === root.id || pathTo(root, parentId).some((w) => w.id === id)) return root
  const w = findWidget(root, id)
  const oldParent = findParent(root, id)
  if (!w || !oldParent) return root
  // 同一个父控件里往后挪，先删掉后索引会少一个
  const from = oldParent.Children!.findIndex((c) => c.id === id)
  const at = oldParent.id === parentId && index !== undefined && index > from ? index - 1 : index
  const w2 = oldParent.id === parentId ? w : { ...w, Slot: undefined }
  return insertWidget(removeWidget(root, id), parentId, w2, at)
}

/** 换父控件时插槽换类型：内边距、对齐这些通用字段带过去 */
export function adaptSlot(slot: Record<string, any> | undefined, type: SlotType | undefined) {
  const base = defaultSlot(type)
  if (!base || !slot) return base
  const out: Record<string, any> = { ...base }
  for (const k of Object.keys(base)) if (k in slot) out[k] = slot[k]
  return out
}

/** 复制一份（换掉所有 id、名字加后缀） */
export function cloneWidget(w: Widget, names: Set<string>): Widget {
  const c: Widget = { ...structuredClone(w), id: newId(), Name: uniqueName(w.Name, names) }
  names.add(c.Name)
  c.Children = w.Children?.map((k) => cloneWidget(k, names))
  return c
}

/**
 * 包裹为：在 id 的位置放一个新的面板，原来的控件成为它唯一的子控件。
 * 新面板接过原来的插槽（位置、大小不变）；子控件在 CanvasPanel 里铺满，其他面板用默认插槽
 */
export function wrapWidget(
  root: Widget,
  id: string,
  type: WidgetType,
  names: Set<string>,
): { root: Widget; id: string } {
  const w = findWidget(root, id)
  if (!w || !isPanel(type)) return { root, id }
  const wrapper = newWidget(type, uniqueName(type, names), w.Slot)
  const slotType = WIDGETS[type].slot
  let childSlot = defaultSlot(slotType)
  if (slotType === 'CanvasPanelSlot')
    childSlot = {
      ...childSlot,
      LayoutData: {
        Offsets: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
        Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } },
        Alignment: { X: 0, Y: 0 },
      },
    }
  if (slotType && slotType !== 'CanvasPanelSlot' && childSlot && 'HorizontalAlignment' in childSlot)
    childSlot = { ...childSlot, HorizontalAlignment: 'HAlign_Fill', VerticalAlignment: 'VAlign_Fill' }
  wrapper.Children = [{ ...w, Slot: childSlot }]
  if (w.Slot === undefined) delete wrapper.Slot
  return { root: id === root.id ? wrapper : mapWidget(root, id, () => wrapper), id: wrapper.id }
}

/**
 * 预先摆好的子控件都是同一个子控件（背包里的一排格子）时，换成运行时列表用的条目类；
 * 不是的话返回 undefined，不能换成列表
 */
export function entryClassOf(w: Widget): string | undefined {
  const kids = w.Children ?? []
  if (!kids.length) return ''
  const cls = kids[0].Type === 'UserWidget' ? kids[0].Class : undefined
  return cls && kids.every((k) => k.Type === 'UserWidget' && k.Class === cls) ? cls : undefined
}

/**
 * UniformGridPanel 只在设计器里用的属性：UE 的 UniformGridPanel 没有条目类，格子是真正的子控件，
 * 导出时按这些属性展开成子控件（每个格子的 UniformGridSlot 填好 Row / Column 和对齐）
 */
export const GRID_DESIGN_PROPS = [
  'EntryWidgetClass',
  'NumEntries',
  'NumColumns',
  'EntryHorizontalAlignment',
  'EntryVerticalAlignment',
] as const

/** 条目数：UniformGridPanel 是真正的格子数，运行时列表是设计器里预览几条 */
export const entryCount = (w: Widget) =>
  Math.max(
    0,
    Math.min(
      w.Type === 'UniformGridPanel' ? 100 : 50,
      Number(w.Type === 'UniformGridPanel' ? w.Properties?.NumEntries : w.Properties?.NumDesignerPreviewEntries) || 0,
    ),
  )

/** UniformGridPanel 的第 i 个格子在第几行第几列 */
export const gridCell = (w: Widget, i: number) => {
  const cols = Math.max(1, Number(w.Properties?.NumColumns) || 1)
  return { Row: Math.floor(i / cols), Column: i % cols }
}

/** 能不能把 w 替换成 type：子控件要放得下 */
export function canReplace(w: Widget, type: WidgetType) {
  if (w.Type === type || type === 'UserWidget') return false
  // 换成运行时列表：子控件要都是同一个子控件，换完后用它当条目
  if (WIDGETS[type].entries) return entryClassOf(w) !== undefined
  const n = w.Children?.length ?? 0
  const rule = WIDGETS[type].children
  return rule === 'many' || (rule === 'one' ? n <= 1 : n === 0)
}

/** 替换为：换成另一种控件，名字、插槽和通用属性（可见性、透明度等）保留，子控件换成新面板的插槽 */
export function replaceWidget(root: Widget, id: string, type: WidgetType): Widget {
  return mapWidget(root, id, (w) => {
    if (!canReplace(w, type)) return w
    const common = Object.fromEntries(
      Object.keys(COMMON_PROPS())
        .filter((k) => w.Properties[k] !== undefined)
        .map((k) => [k, w.Properties[k]]),
    )
    const def = WIDGETS[type]
    const entry = def.entries && w.Children?.length ? entryProps(type, w.Children) : {}
    return {
      id: w.id,
      Type: type,
      Name: w.Name,
      ...(w.Slot ? { Slot: w.Slot } : {}),
      Properties: { ...COMMON_PROPS(), ...def.defaults(), ...common, ...entry },
      ...(def.children !== 'none'
        ? { Children: (w.Children ?? []).map((c) => ({ ...c, Slot: adaptSlot(c.Slot, def.slot) })) }
        : {}),
    }
  })
}

/** 预先摆好的同一种格子换成条目属性：UniformGridPanel 记下格子数和列数，运行时列表记下预览几条 */
function entryProps(type: WidgetType, kids: Widget[]) {
  const cls = entryClassOf({ Children: kids } as Widget) ?? ''
  if (type !== 'UniformGridPanel') return { EntryWidgetClass: cls, NumDesignerPreviewEntries: kids.length }
  const cols = Math.max(...kids.map((k) => Number(k.Slot?.Column ?? 0) + 1), 1)
  return {
    EntryWidgetClass: cls,
    NumEntries: kids.length,
    // 原来只排了一行时按格子数算列数
    NumColumns: kids.some((k) => k.Slot?.Column !== undefined) ? cols : kids.length,
  }
}

/**
 * 以前存下的设计里 UniformGridPanel 直接摆着格子：都是同一个子控件时换成条目属性（格子数、列数）。
 * 格子各不相同的换不了，原样留着，画布照旧显示
 */
export function migrateGrids(w: Widget): Widget {
  const kids = w.Children?.map(migrateGrids)
  if (w.Type === 'UniformGridPanel' && kids?.length && !w.Properties?.EntryWidgetClass && entryClassOf(w)) {
    const { Children: _, ...rest } = w
    return {
      ...rest,
      Properties: { ...WIDGETS.UniformGridPanel.defaults(), ...w.Properties, ...entryProps(w.Type, kids) },
    }
  }
  return kids ? { ...w, Children: kids } : w
}

export function allNames(root: Widget) {
  const s = new Set<string>()
  walk(root, (w) => s.add(w.Name))
  return s
}

/** UE 里同一个蓝图内控件名不能重复：Button → Button_1、Button_2 */
export function uniqueName(base: string, names: Set<string>) {
  const clean = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'Widget'
  if (!names.has(clean)) return clean
  const stem = clean.replace(/_\d+$/, '')
  for (let i = 1; ; i++) if (!names.has(`${stem}_${i}`)) return `${stem}_${i}`
}

// ---- 颜色 ----

/** "#RGB" "#RRGGBB" "#RRGGBBAA" → [r, g, b, a]（0~1，sRGB） */
export function parseColor(hex: unknown): [number, number, number, number] {
  let h = String(hex ?? '').replace('#', '')
  if (h.length === 3) h = h.replace(/./g, '$&$&')
  if (h.length === 6) h += 'FF'
  if (!/^[0-9a-f]{8}$/i.test(h)) return [1, 1, 1, 1]
  return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number, number]
}
export const cssColor = (hex: unknown) => {
  const [r, g, b, a] = parseColor(hex)
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${+a.toFixed(3)})`
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
/** UE 的 FLinearColor（线性空间）；Hex 是原来的 sRGB 值，导入时用 FColor::FromHex 也行 */
export function linearColor(hex: unknown) {
  const [r, g, b, a] = parseColor(hex)
  const f = (n: number) => +n.toFixed(5)
  const h = String(hex ?? '#FFFFFFFF').toUpperCase()
  return { R: f(toLinear(r)), G: f(toLinear(g)), B: f(toLinear(b)), A: f(a), Hex: h.length === 7 ? h + 'FF' : h }
}

/** 字号：UE 的 Size 是 96 DPI 下的磅值，屏幕像素 = Size × 4 / 3 */
export const fontPx = (size: number) => (size * 4) / 3

/** 树里用到的图片 id */
export function usedImages(roots: Widget[]) {
  const ids = new Set<string>()
  const scan = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('img:')) ids.add(v.slice(4))
    else if (v && typeof v === 'object') for (const x of Object.values(v)) scan(x)
  }
  for (const r of roots) walk(r, (w) => scan(w.Properties))
  return ids
}

/** 用到某张图的控件：target 是所在的树（空是主界面，否则是子控件名） */
export function imageUsers(trees: { target: string; root: Widget }[], imageId: string) {
  const ref = `img:${imageId}`
  const has = (v: unknown): boolean =>
    v === ref || (!!v && typeof v === 'object' && Object.values(v as object).some(has))
  const out: { target: string; id: string; name: string }[] = []
  for (const tr of trees)
    walk(tr.root, (w) => has(w.Properties) && out.push({ target: tr.target, id: w.id, name: w.Name }))
  return out
}

/** 能直接放图的控件和放在哪个属性上：Image 的 Brush、Border 的 Background、Button 的普通状态；网页是 Picture 的 Src、Frame / WebButton 的背景图 */
export const IMAGE_SLOT: Partial<Record<WidgetType, string>> = {
  Image: 'Brush',
  Border: 'Background',
  Button: 'WidgetStyle.Normal',
  Picture: 'Src',
  Frame: 'BackgroundImage',
  WebButton: 'BackgroundImage',
}

/**
 * 图片的九宫格边距统一成 0~1 的比例（图片面板和 schema 都按比例存）。
 * AI 有时按像素写（990×936 的框写成 140/120/100/90），超过 1 的按图片宽高换算，再限制在 0~0.49。
 */
export function nineSliceRatios(ns: Margin | undefined, width: number, height: number): Margin | undefined {
  if (!ns) return undefined
  const one = (v: number, size: number) => {
    if (!(v > 0) || !(size > 0)) return 0
    return Math.min(0.49, v > 1 ? v / size : v)
  }
  return {
    Left: one(ns.Left, width),
    Top: one(ns.Top, height),
    Right: one(ns.Right, width),
    Bottom: one(ns.Bottom, height),
  }
}

const hasSlice = (m: Margin) => m.Left + m.Top + m.Right + m.Bottom > 0

export interface SliceImage {
  id: string
  width: number
  height: number
  transparent: boolean
  nineSlice?: Margin
}

/**
 * 画刷的九宫格参数按图片修正：图片的 nineSlice 是唯一来源（图片面板里能改），
 * 引用它的 Box/Border 画刷用同一组比例，ImageSize 填图片实际尺寸。
 * AI 手写的 Margin 和 ImageSize 经常和图片对不上，切线和边宽就会切到花纹。
 * 只改透明图：不透明的九宫格图多半是整张底图，边距里是图片自己的底色，放大出来反而露白。
 */
export function syncBrushSlices(w: Widget, imgs: Map<string, SliceImage>): Widget {
  const fix = (v: any): any => {
    if (!v || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x) => {
        const y = fix(x)
        if (y !== x) changed = true
        return y
      })
      return changed ? out : v
    }
    if (typeof v.ResourceObject === 'string' && v.ResourceObject.startsWith('img:')) {
      const img = imgs.get(v.ResourceObject.slice(4))
      if (img?.nineSlice && img.transparent && (v.DrawAs === 'Box' || v.DrawAs === 'Border'))
        return { ...v, Margin: { ...img.nineSlice }, ImageSize: { X: img.width, Y: img.height } }
    }
    let changed = false
    const out: Record<string, any> = {}
    for (const [k, x] of Object.entries(v)) {
      const y = fix(x)
      if (y !== x) changed = true
      out[k] = y
    }
    return changed ? out : v
  }
  const props = fix(w.Properties)
  const kids = w.Children?.map((c) => syncBrushSlices(c, imgs))
  const kidsChanged = !!kids && kids.some((c, i) => c !== w.Children![i])
  if (props === w.Properties && !kidsChanged) return w
  return { ...w, Properties: props, ...(kids ? { Children: kids } : {}) }
}

/** 把图用到控件上：设好画刷的图片；九宫格的图按 Box 拉伸，Image 顺便把尺寸设成图片尺寸 */
export function assignImage(w: Widget, img: { id: string; width: number; height: number; nineSlice?: Margin }): Widget {
  const path = IMAGE_SLOT[w.Type]
  if (!path) return w
  const keys = path.split('.')
  const props = structuredClone(w.Properties)
  let cur: any = props
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {}
  const last = keys[keys.length - 1]
  // 网页控件的图片属性就是一个 "img:<id>" 字符串
  if (WIDGETS[w.Type]?.group === 'web') return { ...w, Properties: { ...props, [last]: `img:${img.id}` } }
  const nine = nineSliceRatios(img.nineSlice, img.width, img.height)
  cur[last] = {
    ...brush(),
    ...(cur[last] ?? {}),
    ResourceObject: `img:${img.id}`,
    ImageSize: { X: img.width, Y: img.height },
    ...(nine && hasSlice(nine) ? { DrawAs: 'Box', Margin: nine } : {}),
  }
  return { ...w, Properties: props }
}

/** 控件在树里能不能有这些子控件：给 AI 的结果做检查，也给拖放做判断 */
export function checkTree(root: Widget, components: string[], images: Set<string>): string[] {
  const errors: string[] = []
  const names = new Set<string>()
  walk(root, (w, p) => {
    const def = WIDGETS[w.Type]
    if (!def) return errors.push(`未知的控件类型 ${w.Type}（${w.Name}）`)
    if (names.has(w.Name)) errors.push(`控件名重复：${w.Name}`)
    names.add(w.Name)
    const n = w.Children?.length ?? 0
    if (def.children === 'none' && n) errors.push(`${w.Type} 不能有子控件（${w.Name}）`)
    if (def.children === 'one' && n > 1) errors.push(`${w.Type} 只能有一个子控件（${w.Name}）`)
    if (w.Type === 'UserWidget' && !components.includes(w.Class ?? ''))
      errors.push(`UserWidget ${w.Name} 引用的子控件 ${w.Class ?? '（空）'} 不存在`)
    if (def.entries && n)
      errors.push(
        `${w.Type} 的条目是运行时生成的，不能预先放子控件（${w.Name}）：把条目做成子控件，写在 EntryWidgetClass 里`,
      )
    const entry = def.entries ? String(w.Properties?.EntryWidgetClass ?? '') : ''
    if (entry && !components.includes(entry)) errors.push(`${w.Name} 的 EntryWidgetClass 引用的子控件 ${entry} 不存在`)
    if (p && !WIDGETS[p.Type]?.slot) errors.push(`${p.Type} 不能放子控件（${w.Name}）`)
  })
  for (const id of usedImages([root])) if (!images.has(id)) errors.push(`引用了不存在的图片 img:${id}`)
  return errors
}

/**
 * 补齐 AI 或导入的数据：缺的 id、插槽、默认属性补上（深合并默认值），名字去重。
 * AI 只需要写和默认值不一样的属性。
 */
export function normalizeTree(w: any, parentSlot?: SlotType, names = new Set<string>()): Widget {
  const type: WidgetType = WIDGETS[w?.Type as WidgetType] ? w.Type : 'Overlay'
  const def = WIDGETS[type]
  const name = uniqueName(String(w?.Name || type), names)
  names.add(name)
  // 以前的 UniformGridPanel 里直接摆着同一种格子：换成条目属性
  const kids = Array.isArray(w?.Children) ? w.Children : []
  const legacy =
    type === 'UniformGridPanel' && kids.length && !w?.Properties?.EntryWidgetClass && entryClassOf(w)
      ? entryProps(type, kids)
      : {}
  const out: Widget = {
    id: typeof w?.id === 'string' && w.id ? w.id : newId(),
    Type: type,
    Name: name,
    Properties: deepMerge({ ...COMMON_PROPS(), ...def.defaults() }, { ...(w?.Properties ?? {}), ...legacy }),
  }
  if (parentSlot) out.Slot = deepMerge(defaultSlot(parentSlot) ?? {}, w?.Slot ?? {})
  if (type === 'UserWidget') out.Class = String(w?.Class ?? '')
  if (def.children !== 'none')
    out.Children = (Array.isArray(w?.Children) ? w.Children : []).map((c: any) => normalizeTree(c, def.slot, names))
  return out
}

export function deepMerge(base: any, over: any): any {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base
  const out: any = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
        ? deepMerge(base[k], v)
        : v
  }
  return out
}

/** 只留下和默认值不一样的属性：给 AI 看当前设计时省字数 */
export function diffDefaults(cur: any, base: any): any {
  if (cur === base) return undefined
  if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !base || typeof base !== 'object')
    return JSON.stringify(cur) === JSON.stringify(base) ? undefined : cur
  const out: any = {}
  for (const [k, v] of Object.entries(cur)) {
    const d = diffDefaults(v, base[k])
    if (d !== undefined) out[k] = d
  }
  return Object.keys(out).length ? out : undefined
}

/** 精简的树（不含默认值和内部 id）：放进给 AI 的提示里 */
export function compactTree(w: Widget, parentSlot?: SlotType): any {
  const def = WIDGETS[w.Type]
  const props = diffDefaults(w.Properties, { ...COMMON_PROPS(), ...def.defaults() })
  const slot = parentSlot && w.Slot ? diffDefaults(w.Slot, defaultSlot(parentSlot)) : undefined
  return {
    Type: w.Type,
    Name: w.Name,
    ...(w.Class ? { Class: w.Class } : {}),
    ...(slot ? { Slot: slot } : {}),
    ...(props ? { Properties: props } : {}),
    ...(w.Children?.length ? { Children: w.Children.map((c) => compactTree(c, def.slot)) } : {}),
  }
}

// ---- 导出 ----

export interface ExportImage {
  id: string
  name: string
  /** 文件扩展名（png、jpg……） */
  ext: string
  width: number
  height: number
  nineSlice?: Margin
}

export const EXPORT_FORMAT = 'AgentPanel.UMG'
export const EXPORT_VERSION = 1

/** 贴图名：UE 习惯 T_ 开头 */
export const textureName = (name: string) => {
  const n = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^T_/i.test(n) ? n : `T_${n}`
}

/**
 * 导出一个控件：去掉 id，颜色换成 LinearColor，图片换成贴图名，SizeBox 补上 bOverride_ 开关，
 * UniformGridPanel 的格子展开成 UE 里真正的子控件。names 是这棵树里已有的控件名，展开的格子不和它们重名
 */
export function exportWidget(
  w: Widget,
  tex: Map<string, string>,
  slotType?: SlotType,
  names: Set<string> = allNames(w),
): any {
  const conv = (v: any): any => {
    if (typeof v === 'string' && /^#[0-9a-f]{6,8}$/i.test(v)) return linearColor(v)
    if (typeof v === 'string' && v.startsWith('img:')) return tex.get(v.slice(4)) ?? ''
    if (Array.isArray(v)) return v.map(conv)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]))
    return v
  }
  const props = conv(w.Properties)
  if (w.Type === 'SizeBox')
    for (const k of [
      'WidthOverride',
      'HeightOverride',
      'MinDesiredWidth',
      'MinDesiredHeight',
      'MaxDesiredWidth',
      'MaxDesiredHeight',
    ])
      props[`bOverride_${k}`] = (w.Properties[k] ?? 0) > 0
  let children = w.Children?.map((c) => exportWidget(c, tex, WIDGETS[w.Type].slot, names))
  if (w.Type === 'UniformGridPanel') {
    for (const k of GRID_DESIGN_PROPS) delete props[k]
    const cls = String(w.Properties.EntryWidgetClass ?? '')
    if (cls)
      children = Array.from({ length: entryCount(w) }, (_, i) => {
        const name = uniqueName(`${w.Name}_${i}`, names)
        names.add(name)
        return {
          Type: 'UserWidget',
          Name: name,
          Class: cls,
          Slot: {
            Type: 'UniformGridSlot',
            ...gridCell(w, i),
            HorizontalAlignment: w.Properties.EntryHorizontalAlignment ?? 'HAlign_Fill',
            VerticalAlignment: w.Properties.EntryVerticalAlignment ?? 'VAlign_Fill',
          },
          Properties: conv(COMMON_PROPS()),
        }
      })
  }
  return {
    Type: w.Type,
    Name: w.Name,
    ...(w.Type === 'UserWidget' ? { Class: w.Class ?? '' } : {}),
    // 插槽类型写进导出数据，导入时不用再看父控件
    ...(w.Slot && slotType ? { Slot: { Type: slotType, ...conv(w.Slot) } } : {}),
    Properties: props,
    ...(children ? { Children: children } : {}),
  }
}

export function exportDesign(d: {
  title: string
  designSize: Vec2
  root: Widget
  components: Component[]
  images: ExportImage[]
  animations?: UiAnimation[]
}) {
  const tex = new Map<string, string>()
  const anims = (tree: string) => exportAnimations((d.animations ?? []).filter((a) => a.in === tree && a.tracks.length))
  const used = new Set<string>()
  for (const img of d.images) {
    const n = uniqueName(textureName(img.name), used)
    used.add(n)
    tex.set(img.id, n)
  }
  const root = d.root
  const comps = d.components
  const ref = usedImages([root, ...comps.map((c) => c.Root)])
  const used2 = d.images.filter((i) => ref.has(i.id))
  // 蓝图名只能是英文，按 UE 的习惯拼成 PascalCase（Main Menu → WBP_MainMenu）；中文标题换成 WBP_Design
  const ascii = (d.title.match(/[A-Za-z0-9_]+/g) ?? []).map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  const name = /[A-Za-z]/.test(ascii) ? (/^WBP_/i.test(ascii) ? ascii : `WBP_${ascii}`) : 'WBP_Design'
  const json = {
    Format: EXPORT_FORMAT,
    Version: EXPORT_VERSION,
    Name: name,
    DesignSize: d.designSize,
    Textures: used2.map((i) => ({
      Name: tex.get(i.id)!,
      File: `Textures/${tex.get(i.id)}.${i.ext}`,
      Size: { X: i.width, Y: i.height },
      ...(i.nineSlice ? { NineSlice: i.nineSlice } : {}),
    })),
    UserWidgets: comps.map((c) => ({
      Name: c.Name,
      DesignSize: c.DesignSize,
      Root: exportWidget(c.Root, tex),
      Animations: anims(c.Name),
    })),
    Root: exportWidget(root, tex),
    Animations: anims(''),
  }
  /** 每张用到的图片对应导出的哪个文件 */
  const files = used2.map((i) => ({ id: i.id, file: `Textures/${tex.get(i.id)}.${i.ext}` }))
  return { json, files }
}

// ---- 给 AI 的控件说明 ----

export function widgetCatalogText(kind: 'game' | 'web' = 'game') {
  const lines = typesFor(kind).map((t) => {
    const d = WIDGETS[t]
    const kids = d.children === 'many' ? '多个子控件' : d.children === 'one' ? '一个子控件' : '不能有子控件'
    return `- ${t}（${kids}${d.slot ? `，子控件插槽 ${d.slot}` : ''}）：${d.hint}`
  })
  return lines.join('\n')
}
