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
export type WidgetGroup = 'panel' | 'common' | 'input' | 'user'

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
  'Spacer',
  'Image',
  'TextBlock',
  'Button',
  'CheckBox',
  'ProgressBar',
  'Slider',
  'EditableTextBox',
  'UserWidget',
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
  UniformGridPanel: W('UniformGridPanel', 'panel', 'many', 'UniformGridSlot', '等大网格（背包格子、技能栏）', () => ({
    SlotPadding: margin(0),
    MinDesiredSlotWidth: 0,
    MinDesiredSlotHeight: 0,
  })),
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
}

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
  const out: Widget = {
    id: typeof w?.id === 'string' && w.id ? w.id : newId(),
    Type: type,
    Name: name,
    Properties: deepMerge({ ...COMMON_PROPS(), ...def.defaults() }, w?.Properties ?? {}),
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

/** 导出一个控件：去掉 id，颜色换成 LinearColor，图片换成贴图名，SizeBox 补上 bOverride_ 开关 */
export function exportWidget(w: Widget, tex: Map<string, string>, slotType?: SlotType): any {
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
  return {
    Type: w.Type,
    Name: w.Name,
    ...(w.Type === 'UserWidget' ? { Class: w.Class ?? '' } : {}),
    // 插槽类型写进导出数据，导入时不用再看父控件
    ...(w.Slot && slotType ? { Slot: { Type: slotType, ...conv(w.Slot) } } : {}),
    Properties: props,
    ...(w.Children ? { Children: w.Children.map((c) => exportWidget(c, tex, WIDGETS[w.Type].slot)) } : {}),
  }
}

export function exportDesign(d: {
  title: string
  designSize: Vec2
  root: Widget
  components: Component[]
  images: ExportImage[]
}) {
  const tex = new Map<string, string>()
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
    UserWidgets: comps.map((c) => ({ Name: c.Name, DesignSize: c.DesignSize, Root: exportWidget(c.Root, tex) })),
    Root: exportWidget(root, tex),
  }
  /** 每张用到的图片对应导出的哪个文件 */
  const files = used2.map((i) => ({ id: i.id, file: `Textures/${tex.get(i.id)}.${i.ext}` }))
  return { json, files }
}

// ---- 给 AI 的控件说明 ----

export function widgetCatalogText() {
  const lines = WIDGET_TYPES.map((t) => {
    const d = WIDGETS[t]
    const kids = d.children === 'many' ? '多个子控件' : d.children === 'one' ? '一个子控件' : '不能有子控件'
    return `- ${t}（${kids}${d.slot ? `，子控件插槽 ${d.slot}` : ''}）：${d.hint}`
  })
  return lines.join('\n')
}
