import type { Component, Widget } from './umg.ts'

/**
 * shared/umg-layout.ts 的样例树：单测断言具体数值，界面检查（scripts/ui/11-umg-layout.mjs）
 * 把同样的树交给画布组件 UmgNode 在浏览器里画出来，逐个控件比对算出来的位置。
 * 加了新的排版规则就在这里加一棵树，两边一起覆盖。
 */

export interface LayoutFixture {
  name: string
  size: { X: number; Y: number }
  root: Widget
  components?: Component[]
}

let seq = 0
export const w = (Type: string, Name: string, extra: Partial<Widget> & Record<string, any> = {}): Widget => {
  const { Slot, Children, Properties, Class, ...rest } = extra
  return {
    id: `w${++seq}-${Name}`,
    Type: Type as Widget['Type'],
    Name,
    Properties: { ...(Properties ?? {}), ...rest },
    ...(Slot ? { Slot } : {}),
    ...(Children ? { Children } : {}),
    ...(Class ? { Class } : {}),
  }
}

export const canvas = (
  x: number,
  y: number,
  wd: number,
  h: number,
  o: { min?: [number, number]; max?: [number, number]; align?: [number, number]; auto?: boolean; z?: number } = {},
) => ({
  LayoutData: {
    Offsets: { Left: x, Top: y, Right: wd, Bottom: h },
    Anchors: {
      Minimum: { X: o.min?.[0] ?? 0, Y: o.min?.[1] ?? 0 },
      Maximum: { X: o.max?.[0] ?? o.min?.[0] ?? 0, Y: o.max?.[1] ?? o.min?.[1] ?? 0 },
    },
    Alignment: { X: o.align?.[0] ?? 0, Y: o.align?.[1] ?? 0 },
  },
  bAutoSize: !!o.auto,
  ZOrder: o.z ?? 0,
})

export const box = (o: { fill?: number; h?: string; v?: string; pad?: [number, number, number, number] } = {}) => ({
  Padding: { Left: o.pad?.[0] ?? 0, Top: o.pad?.[1] ?? 0, Right: o.pad?.[2] ?? 0, Bottom: o.pad?.[3] ?? 0 },
  Size: { SizeRule: o.fill ? 'Fill' : 'Automatic', Value: o.fill ?? 1 },
  HorizontalAlignment: o.h ?? 'HAlign_Fill',
  VerticalAlignment: o.v ?? 'VAlign_Fill',
})

const img = (x: number, y: number) => ({ Brush: { ImageSize: { X: x, Y: y }, TintColor: '#3B82F6FF' } })

export function layoutFixtures(): LayoutFixture[] {
  return [
    {
      name: '画布锚点',
      size: { X: 1920, Y: 1080 },
      root: w('CanvasPanel', 'Root', {
        Children: [
          w('Image', 'TopLeft', { Slot: canvas(40, 32, 320, 72), ...img(320, 72) }),
          w('Image', 'Center', {
            Slot: canvas(0, 0, 400, 200, { min: [0.5, 0.5], align: [0.5, 0.5] }),
            ...img(10, 10),
          }),
          w('Image', 'BottomRight', {
            Slot: canvas(-24, -24, 100, 50, { min: [1, 1], align: [1, 1] }),
            ...img(10, 10),
          }),
          w('Border', 'Stretch', {
            Slot: canvas(10, 20, 30, 40, { min: [0, 0], max: [1, 1] }),
            Background: { TintColor: '#00000044' },
          }),
          w('Image', 'StretchX', { Slot: canvas(100, 900, 100, 60, { min: [0, 0], max: [1, 0] }), ...img(10, 10) }),
          w('Image', 'Hidden', { Slot: canvas(5, 5, 10, 10), Visibility: 'Hidden', ...img(10, 10) }),
          w('Image', 'Gone', { Slot: canvas(5, 5, 10, 10), Visibility: 'Collapsed', ...img(10, 10) }),
        ],
      }),
    },
    {
      name: '横竖排',
      size: { X: 800, Y: 600 },
      root: w('CanvasPanel', 'Root', {
        Children: [
          w('HorizontalBox', 'Row', {
            Slot: canvas(0, 0, 800, 100),
            Children: [
              w('Image', 'Icon', { Slot: box({ pad: [8, 8, 8, 8], v: 'VAlign_Center' }), ...img(64, 48) }),
              w('Border', 'A', { Slot: box({ fill: 1 }), Background: { TintColor: '#FF000055' } }),
              w('Border', 'B', { Slot: box({ fill: 2, pad: [4, 0, 4, 0] }), Background: { TintColor: '#00FF0055' } }),
              w('Spacer', 'Gap', { Slot: box(), Size: { X: 20, Y: 1 } }),
              w('Image', 'Right', { Slot: box({ v: 'VAlign_Bottom' }), ...img(30, 30) }),
            ],
          }),
          w('VerticalBox', 'Col', {
            Slot: canvas(0, 120, 300, 480),
            Children: [
              w('Image', 'Banner', { Slot: box({ h: 'HAlign_Center', pad: [0, 10, 0, 10] }), ...img(200, 60) }),
              w('Button', 'Btn', {
                Slot: box({ h: 'HAlign_Right' }),
                WidgetStyle: { NormalPadding: { Left: 12, Top: 6, Right: 12, Bottom: 6 } },
                Children: [w('Image', 'BtnIcon', { Slot: { HorizontalAlignment: 'HAlign_Fill' }, ...img(40, 20) })],
              }),
              w('SizeBox', 'Fixed', {
                Slot: box(),
                WidthOverride: 120,
                HeightOverride: 80,
                Children: [w('Border', 'FixedBg', { Background: { TintColor: '#0000FF55' } })],
              }),
              w('Border', 'Rest', { Slot: box({ fill: 1 }), Background: { TintColor: '#FFFF0033' } }),
            ],
          }),
          w('Overlay', 'Stack', {
            Slot: canvas(400, 200, 300, 200),
            Children: [
              w('Border', 'StackBg', {
                Slot: { HorizontalAlignment: 'HAlign_Fill', VerticalAlignment: 'VAlign_Fill' },
              }),
              w('Image', 'Badge', {
                Slot: {
                  Padding: { Left: 0, Top: 8, Right: 8, Bottom: 0 },
                  HorizontalAlignment: 'HAlign_Right',
                  VerticalAlignment: 'VAlign_Top',
                },
                ...img(24, 24),
              }),
              w('Image', 'Mid', {
                Slot: { HorizontalAlignment: 'HAlign_Center', VerticalAlignment: 'VAlign_Center' },
                ...img(50, 30),
              }),
            ],
          }),
        ],
      }),
    },
    {
      name: '变换和其他控件',
      size: { X: 1000, Y: 700 },
      components: [
        {
          Name: 'WBP_Card',
          DesignSize: { X: 120, Y: 90 },
          Root: w('Border', 'CardBg', { Background: { TintColor: '#22222288' } }),
        },
      ],
      root: w('CanvasPanel', 'Root', {
        Children: [
          w('Border', 'Moved', {
            Slot: canvas(100, 100, 200, 100),
            RenderTransform: { Translation: { X: 30, Y: -10 }, Scale: { X: 1.5, Y: 0.5 }, Angle: 0 },
            Children: [
              w('Image', 'Inner', {
                Slot: { HorizontalAlignment: 'HAlign_Left', VerticalAlignment: 'VAlign_Top' },
                ...img(50, 40),
              }),
            ],
          }),
          w('Image', 'Rotated', {
            Slot: canvas(400, 100, 100, 50),
            RenderTransform: { Angle: 30 },
            ...img(10, 10),
          }),
          w('UserWidget', 'Card1', { Slot: canvas(600, 50, 0, 0, { auto: true }), Class: 'WBP_Card' }),
          w('UniformGridPanel', 'Grid', {
            Slot: canvas(50, 300, 300, 200),
            Children: [
              w('Image', 'G00', { Slot: { Row: 0, Column: 0 }, ...img(20, 20) }),
              w('Image', 'G11', {
                Slot: { Row: 1, Column: 1, HorizontalAlignment: 'HAlign_Center', VerticalAlignment: 'VAlign_Center' },
                ...img(20, 20),
              }),
            ],
          }),
          w('WrapBox', 'Wrap', {
            Slot: canvas(400, 300, 250, 300),
            InnerSlotPadding: { X: 10, Y: 6 },
            Children: ['W1', 'W2', 'W3', 'W4'].map((n) =>
              w('Image', n, { Slot: { Padding: { Left: 0, Top: 0, Right: 0, Bottom: 0 } }, ...img(70, 40) }),
            ),
          }),
          w('ScrollBox', 'Scroll', {
            Slot: canvas(700, 300, 200, 150),
            Children: ['S1', 'S2', 'S3'].map((n) =>
              w('Image', n, { Slot: { HorizontalAlignment: 'HAlign_Center' }, ...img(80, 60) }),
            ),
          }),
          w('ProgressBar', 'Bar', { Slot: canvas(50, 600, 0, 0, { auto: true }) }),
          w('Slider', 'Vol', { Slot: canvas(300, 600, 0, 0, { auto: true }) }),
          w('CheckBox', 'Check', {
            Slot: canvas(550, 600, 200, 40),
            Children: [w('Image', 'CheckIcon', { Slot: { HorizontalAlignment: 'HAlign_Fill' }, ...img(30, 20) })],
          }),
        ],
      }),
    },
    {
      name: '文字',
      size: { X: 800, Y: 400 },
      root: w('CanvasPanel', 'Root', {
        Children: [
          w('TextBlock', 'Title', {
            Slot: canvas(20, 20, 0, 0, { auto: true }),
            Text: '背包 Inventory',
            Font: { Size: 24 },
          }),
          w('TextBlock', 'Fixed', { Slot: canvas(20, 80, 300, 40), Text: 'Fixed size', Font: { Size: 18 } }),
          w('VerticalBox', 'List', {
            Slot: canvas(400, 20, 200, 300),
            Children: [
              w('TextBlock', 'Long', {
                Slot: box(),
                Text: '这是一段比较长的说明文字，会按宽度自动换行显示',
                AutoWrapText: true,
                Font: { Size: 12 },
              }),
              w('TextBlock', 'Short', { Slot: box({ h: 'HAlign_Center' }), Text: 'OK', Font: { Size: 16 } }),
              w('Image', 'After', { Slot: box(), ...img(50, 20) }),
            ],
          }),
        ],
      }),
    },
    {
      name: '列表和切换',
      size: { X: 900, Y: 600 },
      components: [
        { Name: 'WBP_Slot', DesignSize: { X: 96, Y: 96 }, Root: w('CanvasPanel', 'SlotRoot') },
        { Name: 'WBP_Row', DesignSize: { X: 300, Y: 48 }, Root: w('Border', 'RowBg') },
      ],
      root: w('CanvasPanel', 'Root', {
        Children: [
          w('UniformGridPanel', 'Bag', {
            Slot: canvas(20, 20, 0, 0, { auto: true }),
            EntryWidgetClass: 'WBP_Slot',
            NumEntries: 7,
            NumColumns: 3,
            SlotPadding: { Left: 4, Top: 4, Right: 4, Bottom: 4 },
          }),
          w('ListView', 'Rows', {
            Slot: canvas(400, 20, 0, 0, { auto: true }),
            EntryWidgetClass: 'WBP_Row',
            NumDesignerPreviewEntries: 3,
            EntrySpacing: 6,
          }),
          w('ListView', 'Empty', { Slot: canvas(400, 300, 0, 0, { auto: true }) }),
          w('WidgetSwitcher', 'Tabs', {
            Slot: canvas(20, 400, 300, 150),
            ActiveWidgetIndex: 1,
            Children: [
              w('Image', 'Tab0', { ...img(10, 10) }),
              w('Image', 'Tab1', {
                Slot: { HorizontalAlignment: 'HAlign_Center', VerticalAlignment: 'VAlign_Center' },
                ...img(40, 40),
              }),
            ],
          }),
          w('SizeBox', 'Clamp', {
            Slot: canvas(400, 400, 0, 0, { auto: true }),
            MinDesiredWidth: 150,
            MaxDesiredHeight: 30,
            Children: [w('Image', 'Big', { ...img(60, 80) })],
          }),
          w('HorizontalBox', 'AutoRow', {
            Slot: canvas(600, 400, 0, 0, { auto: true }),
            Children: [
              w('UserWidget', 'Cell1', { Slot: box({ pad: [0, 0, 8, 0] }), Class: 'WBP_Slot' }),
              w('UserWidget', 'Cell2', { Slot: box({ v: 'VAlign_Center' }), Class: 'WBP_Slot' }),
            ],
          }),
        ],
      }),
    },
    {
      name: '缩放和换行',
      size: { X: 900, Y: 600 },
      root: w('CanvasPanel', 'Root', {
        Children: [
          w('ScaleBox', 'Fit', {
            Slot: canvas(20, 20, 400, 400),
            Stretch: 'ScaleToFit',
            Children: [w('Image', 'FitImg', { ...img(100, 50) })],
          }),
          w('ScaleBox', 'Down', {
            Slot: canvas(450, 20, 400, 400),
            Stretch: 'ScaleToFit',
            StretchDirection: 'DownOnly',
            Children: [w('Image', 'DownImg', { ...img(100, 50) })],
          }),
          w('ScaleBox', 'Stretched', {
            Slot: canvas(20, 440, 200, 100),
            Stretch: 'Fill',
            Children: [w('Image', 'StretchImg', { ...img(50, 50) })],
          }),
          w('VerticalBox', 'Narrow', {
            Slot: canvas(450, 440, 200, 150),
            Children: [
              w('TextBlock', 'Wrapped', {
                Slot: box({ h: 'HAlign_Left' }),
                Text: 'A long line of text that must wrap inside the box',
                AutoWrapText: true,
                Font: { Size: 12 },
              }),
              w('Image', 'Below', { Slot: box({ h: 'HAlign_Left' }), ...img(40, 20) }),
            ],
          }),
        ],
      }),
    },
  ]
}
