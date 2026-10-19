import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { WIDGETS, isWebType, type SlotType, type Widget, type WidgetType } from '@shared/umg'
import { DEVICE_KEY, propsAt, type Device } from '@shared/web'
import type { DesignImage } from '@shared/design'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { t } from '@shared/i18n'
import {
  AlignInput,
  BoolInput,
  BrushInput,
  ColorInput,
  EnumInput,
  FieldRow,
  MarginInput,
  NumInput,
  TextInput,
  Vec2Input,
  getPath,
  setPath,
} from './fields'
import { WIDGET_ICON } from './Hierarchy'

type Kind =
  | 'num'
  | 'text'
  | 'textarea'
  | 'color'
  | 'enum'
  | 'bool'
  | 'vec2'
  | 'margin'
  | 'brush'
  | 'component'
  /** 网页控件的宽高：auto（按内容）、fill（占满）或像素数 */
  | 'size'
  /** 网页控件的图片：选设计里的一张图 */
  | 'image'
interface Spec {
  path: string
  kind: Kind
  options?: string[]
  step?: number
  min?: number
  max?: number
}
const F = (path: string, kind: Kind, more: Partial<Spec> = {}): Spec => ({ path, kind, ...more })
const VIS = ['Visible', 'Collapsed', 'Hidden', 'HitTestInvisible', 'SelfHitTestInvisible']
const ORIENT = ['Orient_Horizontal', 'Orient_Vertical']

/** 每种控件在「外观」里列出的属性（名字和 UE 的 Details 面板一致） */
const PROPS: Partial<Record<WidgetType, Spec[]>> = {
  Image: [F('Brush', 'brush'), F('ColorAndOpacity', 'color')],
  TextBlock: [
    F('Text', 'textarea'),
    F('Font.Size', 'num', { min: 1 }),
    F('Font.TypefaceFontName', 'enum', { options: ['Regular', 'Bold', 'Italic', 'Bold Italic', 'Light'] }),
    F('Font.LetterSpacing', 'num', { step: 10 }),
    F('ColorAndOpacity', 'color'),
    F('Font.OutlineSettings.OutlineSize', 'num', { min: 0 }),
    F('Font.OutlineSettings.OutlineColor', 'color'),
    F('ShadowOffset', 'vec2'),
    F('ShadowColorAndOpacity', 'color'),
    F('Justification', 'enum', { options: ['Left', 'Center', 'Right'] }),
    F('AutoWrapText', 'bool'),
  ],
  Button: [
    F('WidgetStyle.Normal', 'brush'),
    F('WidgetStyle.Hovered', 'brush'),
    F('WidgetStyle.Pressed', 'brush'),
    F('WidgetStyle.Disabled', 'brush'),
    F('WidgetStyle.NormalPadding', 'margin'),
    F('WidgetStyle.PressedPadding', 'margin'),
    F('BackgroundColor', 'color'),
    F('IsFocusable', 'bool'),
  ],
  Border: [F('Background', 'brush'), F('BrushColor', 'color'), F('ContentColorAndOpacity', 'color')],
  ProgressBar: [
    F('Percent', 'num', { step: 0.05, min: 0, max: 1 }),
    F('BarFillType', 'enum', {
      options: ['LeftToRight', 'RightToLeft', 'FillFromCenter', 'TopToBottom', 'BottomToTop'],
    }),
    F('WidgetStyle.BackgroundImage', 'brush'),
    F('WidgetStyle.FillImage', 'brush'),
    F('FillColorAndOpacity', 'color'),
  ],
  Slider: [
    F('Value', 'num', { step: 0.05 }),
    F('MinValue', 'num'),
    F('MaxValue', 'num'),
    F('Orientation', 'enum', { options: ORIENT }),
    F('WidgetStyle.NormalBarImage', 'brush'),
    F('WidgetStyle.NormalThumbImage', 'brush'),
    F('SliderBarColor', 'color'),
    F('SliderHandleColor', 'color'),
  ],
  CheckBox: [
    F('CheckedState', 'enum', { options: ['Unchecked', 'Checked', 'Undetermined'] }),
    F('WidgetStyle.UncheckedImage', 'brush'),
    F('WidgetStyle.CheckedImage', 'brush'),
  ],
  EditableTextBox: [
    F('Text', 'text'),
    F('HintText', 'text'),
    F('Font.Size', 'num', { min: 1 }),
    F('ForegroundColor', 'color'),
    F('WidgetStyle.BackgroundImageNormal', 'brush'),
  ],
  SizeBox: [
    F('WidthOverride', 'num', { min: 0 }),
    F('HeightOverride', 'num', { min: 0 }),
    F('MinDesiredWidth', 'num', { min: 0 }),
    F('MinDesiredHeight', 'num', { min: 0 }),
    F('MaxDesiredWidth', 'num', { min: 0 }),
    F('MaxDesiredHeight', 'num', { min: 0 }),
  ],
  ScaleBox: [
    F('Stretch', 'enum', {
      options: ['None', 'Fill', 'ScaleToFit', 'ScaleToFitX', 'ScaleToFitY', 'ScaleToFill', 'UserSpecified'],
    }),
    F('StretchDirection', 'enum', { options: ['Both', 'DownOnly', 'UpOnly'] }),
  ],
  UniformGridPanel: [
    F('EntryWidgetClass', 'component'),
    F('NumEntries', 'num', { min: 0, max: 100 }),
    F('NumColumns', 'num', { min: 1, max: 20 }),
    F('SlotPadding', 'margin'),
    F('MinDesiredSlotWidth', 'num', { min: 0 }),
    F('MinDesiredSlotHeight', 'num', { min: 0 }),
    F('EntryHorizontalAlignment', 'enum', { options: ['HAlign_Fill', 'HAlign_Left', 'HAlign_Center', 'HAlign_Right'] }),
    F('EntryVerticalAlignment', 'enum', { options: ['VAlign_Fill', 'VAlign_Top', 'VAlign_Center', 'VAlign_Bottom'] }),
  ],
  WrapBox: [F('InnerSlotPadding', 'vec2'), F('Orientation', 'enum', { options: ORIENT })],
  ScrollBox: [
    F('Orientation', 'enum', { options: ORIENT }),
    F('ScrollBarVisibility', 'enum', { options: ['Visible', 'Collapsed', 'Hidden'] }),
  ],
  WidgetSwitcher: [F('ActiveWidgetIndex', 'num', { min: 0 })],
  ListView: [
    F('EntryWidgetClass', 'component'),
    F('NumDesignerPreviewEntries', 'num', { min: 0, max: 50 }),
    F('Orientation', 'enum', { options: ORIENT }),
    F('EntrySpacing', 'num', { min: 0 }),
    F('SelectionMode', 'enum', { options: ['None', 'Single', 'SingleToggle', 'Multi'] }),
  ],
  TileView: [
    F('EntryWidgetClass', 'component'),
    F('NumDesignerPreviewEntries', 'num', { min: 0, max: 50 }),
    F('EntryWidth', 'num', { min: 1 }),
    F('EntryHeight', 'num', { min: 1 }),
    F('Orientation', 'enum', { options: ORIENT }),
    F('TileAlignment', 'enum', {
      options: ['EvenlyDistributed', 'EvenlySize', 'EvenlyWide', 'Left', 'Right', 'Center', 'Fill'],
    }),
    F('SelectionMode', 'enum', { options: ['None', 'Single', 'SingleToggle', 'Multi'] }),
  ],
  DynamicEntryBox: [
    F('EntryWidgetClass', 'component'),
    F('NumDesignerPreviewEntries', 'num', { min: 0, max: 50 }),
    F('EntryBoxType', 'enum', { options: ['Horizontal', 'Vertical', 'Wrap', 'VerticalWrap', 'Overlay'] }),
    F('EntrySpacing', 'vec2'),
  ],
  Spacer: [F('Size', 'vec2')],
  // ---- 网页 UI ----
  Frame: [
    F('Direction', 'enum', { options: ['column', 'row'] }),
    F('Gap', 'num', { min: 0 }),
    F('Padding', 'margin'),
    F('AlignItems', 'enum', { options: ['stretch', 'start', 'center', 'end'] }),
    F('JustifyContent', 'enum', { options: ['start', 'center', 'end', 'between', 'around', 'evenly'] }),
    F('Wrap', 'bool'),
    F('Width', 'size'),
    F('Height', 'size'),
    F('Background', 'color'),
    F('BackgroundImage', 'image'),
    F('Radius', 'num', { min: 0 }),
    F('BorderWidth', 'num', { min: 0 }),
    F('BorderColor', 'color'),
    F('Shadow', 'enum', { options: ['none', 'sm', 'md', 'lg'] }),
    F('Overflow', 'enum', { options: ['visible', 'hidden', 'auto', 'scroll-x', 'scroll-y'] }),
    F('Href', 'text'),
  ],
  Text: [
    F('Text', 'textarea'),
    F('Tag', 'enum', { options: ['p', 'h1', 'h2', 'h3', 'h4', 'span', 'label'] }),
    F('FontSize', 'num', { min: 1 }),
    F('FontWeight', 'enum', { options: ['300', '400', '500', '600', '700', '800'] }),
    F('Color', 'color'),
    F('TextAlign', 'enum', { options: ['left', 'center', 'right'] }),
    F('LineHeight', 'num', { step: 0.1, min: 0.5 }),
    F('LetterSpacing', 'num', { step: 0.5 }),
    F('Width', 'size'),
    F('Height', 'size'),
    F('Href', 'text'),
    F('Underline', 'bool'),
  ],
  Picture: [
    F('Src', 'image'),
    F('Fit', 'enum', { options: ['cover', 'contain', 'fill', 'none'] }),
    F('Width', 'size'),
    F('Height', 'size'),
    F('Radius', 'num', { min: 0 }),
    F('Alt', 'text'),
    F('Href', 'text'),
  ],
  WebButton: [
    F('Text', 'text'),
    F('FontSize', 'num', { min: 1 }),
    F('FontWeight', 'enum', { options: ['400', '500', '600', '700'] }),
    F('Color', 'color'),
    F('Background', 'color'),
    F('BackgroundImage', 'image'),
    F('Padding', 'margin'),
    F('Radius', 'num', { min: 0 }),
    F('BorderWidth', 'num', { min: 0 }),
    F('BorderColor', 'color'),
    F('Shadow', 'enum', { options: ['none', 'sm', 'md', 'lg'] }),
    F('Width', 'size'),
    F('Height', 'size'),
    F('Href', 'text'),
  ],
  Input: [
    F('Placeholder', 'text'),
    F('Value', 'text'),
    F('InputType', 'enum', { options: ['text', 'password', 'email', 'number', 'search', 'tel'] }),
    F('Multiline', 'bool'),
    F('FontSize', 'num', { min: 1 }),
    F('Color', 'color'),
    F('Background', 'color'),
    F('BorderWidth', 'num', { min: 0 }),
    F('BorderColor', 'color'),
    F('Radius', 'num', { min: 0 }),
    F('Padding', 'margin'),
    F('Width', 'size'),
    F('Height', 'size'),
  ],
  Divider: [F('Color', 'color'), F('Thickness', 'num', { min: 1 }), F('Vertical', 'bool')],
}

/** 网页控件鼠标移上去时的样式（写在 Properties.Hover 里） */
const HOVER: Partial<Record<WidgetType, Spec[]>> = {
  Frame: [
    F('Hover.Background', 'color'),
    F('Hover.BorderColor', 'color'),
    F('Hover.Shadow', 'enum', { options: ['none', 'sm', 'md', 'lg'] }),
  ],
  Text: [F('Hover.Color', 'color'), F('Hover.Underline', 'bool')],
  WebButton: [
    F('Hover.Background', 'color'),
    F('Hover.Color', 'color'),
    F('Hover.BorderColor', 'color'),
    F('Hover.Shadow', 'enum', { options: ['none', 'sm', 'md', 'lg'] }),
  ],
  Picture: [F('Hover.RenderOpacity', 'num', { step: 0.05, min: 0, max: 1 })],
  Input: [F('Hover.BorderColor', 'color')],
}

const COMMON: Spec[] = [
  F('Visibility', 'enum', { options: VIS }),
  F('RenderOpacity', 'num', { step: 0.05, min: 0, max: 1 }),
  F('bIsEnabled', 'bool'),
  F('ToolTipText', 'text'),
  F('RenderTransform.Translation', 'vec2'),
  F('RenderTransform.Scale', 'vec2', { step: 0.05 }),
  F('RenderTransform.Angle', 'num'),
  F('RenderTransformPivot', 'vec2', { step: 0.05 }),
]

/** CanvasPanelSlot 的锚点预设，和 UE 的锚点菜单一样 4×4 */
const ANCHORS: { min: [number, number]; max: [number, number] }[] = [
  [0, 0, 0, 0],
  [0.5, 0, 0.5, 0],
  [1, 0, 1, 0],
  [0, 0, 1, 0],
  [0, 0.5, 0, 0.5],
  [0.5, 0.5, 0.5, 0.5],
  [1, 0.5, 1, 0.5],
  [0, 0.5, 1, 0.5],
  [0, 1, 0, 1],
  [0.5, 1, 0.5, 1],
  [1, 1, 1, 1],
  [0, 1, 1, 1],
  [0, 0, 0, 1],
  [0.5, 0, 0.5, 1],
  [1, 0, 1, 1],
  [0, 0, 1, 1],
].map(([a, b, c, d]) => ({ min: [a, b], max: [c, d] }))

/**
 * 换锚点时保持控件在画面上的位置和大小不变（换算偏移），和 UE 里拖锚点的效果一样。
 * parent 是父控件的像素尺寸。
 */
export function reanchor(
  slot: any,
  min: [number, number],
  max: [number, number],
  parent: { w: number; h: number },
  /** move：同时移到锚点上（UE 里按住 Ctrl）；pivot：对齐点也设成锚点（UE 里按住 Shift） */
  o: { move?: boolean; pivot?: boolean } = {},
) {
  const L = slot.LayoutData
  const axis = (i: 0 | 1) => {
    const P = i ? parent.h : parent.w
    const k = i ? 'Y' : 'X'
    const [lo, hi] = i ? (['Top', 'Bottom'] as const) : (['Left', 'Right'] as const)
    const aMin = L.Anchors.Minimum[k]
    const aMax = L.Anchors.Maximum[k]
    const al = L.Alignment[k]
    let x: number
    let w: number
    if (aMin !== aMax) {
      x = aMin * P + L.Offsets[lo]
      w = aMax * P - L.Offsets[hi] - x
    } else {
      w = L.Offsets[hi]
      x = aMin * P + L.Offsets[lo] - al * w
    }
    const nMin = min[i]
    const nMax = max[i]
    // 拉伸：贴满锚点范围；不拉伸：对齐点放在锚点上
    if (o.move) return nMin !== nMax ? { [lo]: 0, [hi]: 0 } : { [lo]: 0, [hi]: Math.round(w) }
    if (nMin !== nMax) return { [lo]: Math.round(x - nMin * P), [hi]: Math.round(nMax * P - (x + w)) }
    const nal = o.pivot ? nMin : al
    return { [lo]: Math.round(x - nMin * P + nal * w), [hi]: Math.round(w) }
  }
  const pivot = (i: 0 | 1) => (min[i] === max[i] ? min[i] : (min[i] + max[i]) / 2)
  return {
    ...slot,
    LayoutData: {
      ...L,
      Anchors: { Minimum: { X: min[0], Y: min[1] }, Maximum: { X: max[0], Y: max[1] } },
      Offsets: { ...axis(0), ...axis(1) },
      ...(o.pivot ? { Alignment: { X: pivot(0), Y: pivot(1) } } : {}),
    },
  }
}

function AnchorPick({
  slot,
  onPick,
}: {
  slot: any
  onPick: (min: [number, number], max: [number, number], o: { move: boolean; pivot: boolean }) => void
}) {
  const [open, setOpen] = useState(false)
  // 默认换锚点时一起移过去、对齐点也跟着换（选右下角就贴到右下角）；取消勾选就和 UE 默认一样只换锚点、位置不动，
  // 按住 Ctrl / Shift 点也能临时打开
  const [move, setMove] = useState(true)
  const [pivot, setPivot] = useState(true)
  const a = slot.LayoutData.Anchors
  const same = (x: (typeof ANCHORS)[number]) =>
    x.min[0] === a.Minimum.X && x.min[1] === a.Minimum.Y && x.max[0] === a.Maximum.X && x.max[1] === a.Maximum.Y
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-field px-1.5 text-[0.75rem] hover:border-line-strong">
          <AnchorIcon min={[a.Minimum.X, a.Minimum.Y]} max={[a.Maximum.X, a.Maximum.Y]} />
          <span className="font-mono text-[0.6875rem] text-muted">
            ({a.Minimum.X},{a.Minimum.Y}) ({a.Maximum.X},{a.Maximum.Y})
          </span>
          <ChevronDown className="h-3 w-3 text-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2">
        <div className="grid grid-cols-4 gap-1">
          {ANCHORS.map((x, i) => (
            <button
              key={i}
              onClick={(e) => {
                onPick(x.min as [number, number], x.max as [number, number], {
                  move: move || e.ctrlKey || e.metaKey,
                  pivot: pivot || e.shiftKey,
                })
                setOpen(false)
              }}
              className={cn('cursor-pointer rounded-md p-1 hover:bg-sel', same(x) && 'bg-accent-soft')}
            >
              <AnchorIcon min={x.min as [number, number]} max={x.max as [number, number]} big />
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-1 border-t pt-2 text-[0.71875rem] text-muted">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
            {t('同时移到锚点（Ctrl）')}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={pivot} onChange={(e) => setPivot(e.target.checked)} />
            {t('同时设对齐点（Shift）')}
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 锚点示意：外框是父控件，橙色是锚点覆盖的范围 */
function AnchorIcon({ min, max, big }: { min: [number, number]; max: [number, number]; big?: boolean }) {
  const s = big ? 36 : 16
  const p = big ? 4 : 2
  const inner = s - p * 2
  const x1 = p + min[0] * inner
  const y1 = p + min[1] * inner
  const x2 = p + max[0] * inner
  const y2 = p + max[1] * inner
  return (
    <svg width={s} height={s} className="shrink-0">
      <rect x={p} y={p} width={inner} height={inner} rx={2} className="fill-none stroke-line-strong" />
      {x1 === x2 && y1 === y2 ? (
        <circle cx={x1} cy={y1} r={big ? 3 : 2} className="fill-accent" />
      ) : (
        <rect
          x={Math.min(x1, x2) - (x1 === x2 ? 1.5 : 0)}
          y={Math.min(y1, y2) - (y1 === y2 ? 1.5 : 0)}
          width={Math.max(3, Math.abs(x2 - x1))}
          height={Math.max(3, Math.abs(y2 - y1))}
          className="fill-accent/70"
        />
      )}
    </svg>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="border-b">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-8 w-full cursor-pointer items-center gap-1 bg-panel px-2 text-[0.71875rem] font-medium tracking-wide text-muted hover:text-fg"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
        {title}
      </button>
      {open && <div className="py-1">{children}</div>}
    </section>
  )
}

const shortLabel = (path: string) => path.split('.').slice(-1)[0]

/** 属性面板（Details）：插槽、外观、通用三组 */
export function Details({
  widget,
  slotType,
  parentSize,
  images,
  url,
  components,
  onChange,
  device = 'desktop',
}: {
  /** 网页 UI 正在按哪个宽度预览：平板、手机时外观的改动只写进这个宽度的断点 */
  device?: Device
  widget: Widget
  slotType?: SlotType
  parentSize: () => { w: number; h: number }
  images: DesignImage[]
  url: (img: DesignImage) => string | undefined
  components: string[]
  onChange: (w: Widget, key: string) => void
}) {
  const Icon = WIDGET_ICON[widget.Type]
  const setProp = (path: string, v: unknown) =>
    onChange({ ...widget, Properties: setPath(widget.Properties, path, v) }, `p:${widget.id}:${path}`)
  const web = isWebType(widget.Type)
  const bp = web && device !== 'desktop' ? DEVICE_KEY[device] : undefined
  // 平板、手机上看到的是叠上断点改动后的值，改的也只是这个宽度
  const getLook = (path: string) => getPath(bp ? propsAt(widget.Properties, device) : widget.Properties, path)
  const setLook = (path: string, v: unknown) => setProp(bp ? `${bp}.${path}` : path, v)
  const setSlot = (path: string, v: unknown) =>
    onChange({ ...widget, Slot: setPath(widget.Slot, path, v) }, `s:${widget.id}:${path}`)

  const field = (s: Spec, get: (p: string) => any, set: (p: string, v: unknown) => void) => {
    const v = get(s.path)
    const label = shortLabel(s.path)
    let input: React.ReactNode
    switch (s.kind) {
      case 'num':
        input = (
          <NumInput
            label={label}
            value={Number(v ?? 0)}
            step={s.step}
            min={s.min}
            max={s.max}
            onChange={(n) => set(s.path, n)}
          />
        )
        break
      case 'text':
      case 'textarea':
        input = (
          <TextInput
            label={label}
            value={String(v ?? '')}
            multiline={s.kind === 'textarea'}
            onChange={(x) => set(s.path, x)}
          />
        )
        break
      case 'color':
        input = <ColorInput value={String(v ?? '#FFFFFFFF')} onChange={(x) => set(s.path, x)} />
        break
      case 'enum':
        input = (
          <EnumInput
            label={label}
            value={String(v ?? s.options?.[0])}
            options={s.options ?? []}
            onChange={(x) => set(s.path, x)}
          />
        )
        break
      case 'bool':
        input = <BoolInput label={label} value={!!v} onChange={(x) => set(s.path, x)} />
        break
      case 'vec2':
        input = <Vec2Input value={v} step={s.step} onChange={(x) => set(s.path, x)} />
        break
      case 'margin':
        input = <MarginInput value={v} onChange={(x) => set(s.path, x)} />
        break
      case 'size': {
        const mode = typeof v === 'number' ? 'fixed' : v === 'fill' ? 'fill' : 'auto'
        input = (
          <>
            <EnumInput
              label={label}
              value={mode}
              options={['auto', 'fill', 'fixed']}
              onChange={(x) => set(s.path, x === 'fixed' ? (typeof v === 'number' ? v : 100) : x)}
            />
            {mode === 'fixed' && (
              <div className="w-16 shrink-0">
                <NumInput label={label} min={0} value={v as number} onChange={(n) => set(s.path, n)} />
              </div>
            )}
          </>
        )
        break
      }
      case 'image':
        input = (
          <Select
            aria-label={label}
            value={typeof v === 'string' ? v.replace(/^img:/, '') : ''}
            placeholder={images.length ? t('选择图片') : t('还没有图片')}
            onChange={(e) => set(s.path, e.target.value ? `img:${e.target.value}` : '')}
            options={[{ value: '', label: t('无') }, ...images.map((i) => ({ value: i.id, label: i.name }))]}
            className="h-7 rounded-md px-2 text-[0.75rem]"
          />
        )
        break
      case 'component':
        input = (
          <Select
            aria-label={label}
            value={String(v ?? '')}
            placeholder={components.length ? t('选择子控件') : t('先提取一个子控件')}
            onChange={(e) => set(s.path, e.target.value)}
            options={components.map((c) => ({ value: c, label: c }))}
            className="h-7 rounded-md px-2 text-[0.75rem]"
          />
        )
        break
      case 'brush':
        return (
          <div key={s.path} className="border-t border-line/60 px-3 py-1.5 first:border-t-0">
            <p className="mb-1 text-[0.75rem] text-subtle">{s.path.replace(/^WidgetStyle\./, '')}</p>
            <BrushInput value={v} images={images} url={url} onChange={(x) => set(s.path, x)} />
          </div>
        )
    }
    return (
      <FieldRow key={s.path} label={label} title={s.path}>
        {input}
      </FieldRow>
    )
  }

  const slot = widget.Slot
  const canvas = slotType === 'CanvasPanelSlot' && slot?.LayoutData
  const stretchX = canvas && slot.LayoutData.Anchors.Minimum.X !== slot.LayoutData.Anchors.Maximum.X
  const stretchY = canvas && slot.LayoutData.Anchors.Minimum.Y !== slot.LayoutData.Anchors.Maximum.Y
  const gs = (p: string) => getPath(slot, p)

  return (
    <div className="text-[0.75rem]">
      {/* 名字和类型固定在属性面板顶上，往下翻属性时一直能看到选的是哪个控件 */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-2">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] font-medium">{widget.Name}</span>
        <span className="shrink-0 rounded bg-sel px-1.5 py-px text-[0.65625rem] text-subtle">{widget.Type}</span>
      </div>
      {widget.Type === 'UserWidget' && (
        <Section title={t('子控件')}>
          <FieldRow label="Class">
            <EnumInput
              label="Class"
              value={widget.Class ?? ''}
              options={components}
              onChange={(c) => onChange({ ...widget, Class: c }, `c:${widget.id}`)}
            />
          </FieldRow>
        </Section>
      )}
      {slot && slotType && (
        <Section title={`${t('插槽')}（${slotType}）`}>
          {slotType === 'FlexSlot' ? (
            <>
              <FieldRow label="Position" title={t('absolute：不占位置，贴在父控件的某个角上（角标、浮层）')}>
                <EnumInput
                  label="Position"
                  value={String(slot.Position ?? 'flow')}
                  options={['flow', 'absolute']}
                  onChange={(v) => setSlot('Position', v)}
                />
              </FieldRow>
              {slot.Position === 'absolute' ? (
                <>
                  <FieldRow label="Pin">
                    <EnumInput
                      label="Pin"
                      value={String(slot.Pin ?? 'top-left')}
                      options={['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']}
                      onChange={(v) => setSlot('Pin', v)}
                    />
                  </FieldRow>
                  <FieldRow label={t('偏移')}>
                    <NumInput prefix="X" value={slot.X ?? 0} onChange={(n) => setSlot('X', n)} />
                    <NumInput prefix="Y" value={slot.Y ?? 0} onChange={(n) => setSlot('Y', n)} />
                  </FieldRow>
                  <FieldRow label="ZIndex">
                    <NumInput label="ZIndex" value={slot.ZIndex ?? 0} onChange={(n) => setSlot('ZIndex', n)} />
                  </FieldRow>
                </>
              ) : (
                <FieldRow label="AlignSelf" title={t('在父控件的交叉轴上怎么对齐，auto 跟随父控件的 AlignItems')}>
                  <EnumInput
                    label="AlignSelf"
                    value={String(slot.AlignSelf ?? 'auto')}
                    options={['auto', 'start', 'center', 'end', 'stretch']}
                    onChange={(v) => setSlot('AlignSelf', v)}
                  />
                </FieldRow>
              )}
            </>
          ) : canvas ? (
            <>
              <FieldRow label="Anchors">
                <AnchorPick
                  slot={slot}
                  onPick={(min, max, o) =>
                    onChange({ ...widget, Slot: reanchor(slot, min, max, parentSize(), o) }, `anchor:${widget.id}`)
                  }
                />
              </FieldRow>
              {stretchX ? (
                <FieldRow label={t('左 / 右')}>
                  <NumInput
                    prefix="L"
                    value={gs('LayoutData.Offsets.Left')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Left', n)}
                  />
                  <NumInput
                    prefix="R"
                    value={gs('LayoutData.Offsets.Right')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Right', n)}
                  />
                </FieldRow>
              ) : (
                <FieldRow label={t('X / 宽')}>
                  <NumInput
                    prefix="X"
                    value={gs('LayoutData.Offsets.Left')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Left', n)}
                  />
                  <NumInput
                    prefix="W"
                    value={gs('LayoutData.Offsets.Right')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Right', n)}
                  />
                </FieldRow>
              )}
              {stretchY ? (
                <FieldRow label={t('上 / 下')}>
                  <NumInput
                    prefix="T"
                    value={gs('LayoutData.Offsets.Top')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Top', n)}
                  />
                  <NumInput
                    prefix="B"
                    value={gs('LayoutData.Offsets.Bottom')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Bottom', n)}
                  />
                </FieldRow>
              ) : (
                <FieldRow label={t('Y / 高')}>
                  <NumInput
                    prefix="Y"
                    value={gs('LayoutData.Offsets.Top')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Top', n)}
                  />
                  <NumInput
                    prefix="H"
                    value={gs('LayoutData.Offsets.Bottom')}
                    onChange={(n) => setSlot('LayoutData.Offsets.Bottom', n)}
                  />
                </FieldRow>
              )}
              <FieldRow label="Alignment">
                <Vec2Input
                  step={0.5}
                  value={gs('LayoutData.Alignment')}
                  onChange={(v) => setSlot('LayoutData.Alignment', v)}
                />
              </FieldRow>
              <FieldRow label="Size To Content">
                <BoolInput label="bAutoSize" value={!!slot.bAutoSize} onChange={(v) => setSlot('bAutoSize', v)} />
              </FieldRow>
              <FieldRow label="ZOrder">
                <NumInput label="ZOrder" value={slot.ZOrder ?? 0} onChange={(n) => setSlot('ZOrder', n)} />
              </FieldRow>
            </>
          ) : (
            <>
              {'Padding' in slot && (
                <FieldRow label="Padding">
                  <MarginInput value={slot.Padding} onChange={(v) => setSlot('Padding', v)} />
                </FieldRow>
              )}
              {'Size' in slot && (
                <FieldRow label="Size">
                  <EnumInput
                    label="SizeRule"
                    value={slot.Size?.SizeRule ?? 'Automatic'}
                    options={['Automatic', 'Fill']}
                    onChange={(v) => setSlot('Size.SizeRule', v)}
                  />
                  {slot.Size?.SizeRule === 'Fill' && (
                    <div className="w-14 shrink-0">
                      <NumInput
                        label="Value"
                        step={0.1}
                        min={0}
                        value={slot.Size?.Value ?? 1}
                        onChange={(n) => setSlot('Size.Value', n)}
                      />
                    </div>
                  )}
                </FieldRow>
              )}
              {'Row' in slot && (
                <FieldRow label={t('行 / 列')}>
                  <NumInput prefix="R" min={0} value={slot.Row} onChange={(n) => setSlot('Row', n)} />
                  <NumInput prefix="C" min={0} value={slot.Column} onChange={(n) => setSlot('Column', n)} />
                </FieldRow>
              )}
              {'bFillEmptySpace' in slot && (
                <FieldRow label="Fill Empty Space">
                  <BoolInput
                    label="bFillEmptySpace"
                    value={slot.bFillEmptySpace}
                    onChange={(v) => setSlot('bFillEmptySpace', v)}
                  />
                </FieldRow>
              )}
              <FieldRow label="Horizontal">
                <AlignInput
                  axis="h"
                  value={slot.HorizontalAlignment}
                  onChange={(v) => setSlot('HorizontalAlignment', v)}
                />
              </FieldRow>
              <FieldRow label="Vertical">
                <AlignInput axis="v" value={slot.VerticalAlignment} onChange={(v) => setSlot('VerticalAlignment', v)} />
              </FieldRow>
            </>
          )}
        </Section>
      )}
      {PROPS[widget.Type] && (
        <Section
          title={bp ? t('外观（{device}）', { device: device === 'tablet' ? t('平板') : t('手机') }) : t('外观')}
        >
          {bp && (
            <div className="mx-3 my-1.5 flex items-center gap-2 rounded-md bg-accent-soft/50 px-2 py-1.5 text-[0.71875rem] leading-relaxed text-accent">
              <span className="flex-1">
                {t('正在改{device}宽度下的样式，只影响这个宽度，桌面不变', {
                  device: device === 'tablet' ? t('平板') : t('手机'),
                })}
              </span>
              {widget.Properties?.[bp] && (
                <button
                  onClick={() => {
                    const { [bp]: _, ...rest } = widget.Properties
                    onChange({ ...widget, Properties: rest }, `bp:${widget.id}`)
                  }}
                  className="shrink-0 cursor-pointer underline"
                >
                  {t('还原')}
                </button>
              )}
            </div>
          )}
          {PROPS[widget.Type]!.map((s) => field(s, getLook, setLook))}
        </Section>
      )}
      {HOVER[widget.Type] && (
        <Section title={t('悬停')}>
          {HOVER[widget.Type]!.map((s) => field(s, (p) => getPath(widget.Properties, p), setProp))}
        </Section>
      )}
      <Section title={t('通用')}>
        {/* 网页控件只有可见性和透明度；变换、提示文字这些是 UMG 的 */}
        {/* 平板、手机上也能单独隐藏（Visibility 选 Collapsed） */}
        {(web ? COMMON.slice(0, 2) : COMMON).map((s) => field(s, getLook, setLook))}
      </Section>
      <p className="px-3 py-3 text-[0.6875rem] leading-relaxed text-subtle">{WIDGETS[widget.Type]?.hint}</p>
    </div>
  )
}
