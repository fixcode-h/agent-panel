import type { Widget } from './umg.ts'

/**
 * shared/web-layout.ts 的样例树：单测断言具体数值，界面检查（scripts/ui/11-umg-layout.mjs）把同样的树
 * 交给画布组件（WebNode）在浏览器里画出来逐个比对。加了新的样式规则就在这里加一棵
 */
export interface WebLayoutFixture {
  name: string
  size: { X: number; Y: number }
  root: Widget
}

let seq = 0
const w = (Type: string, Name: string, props: Record<string, any> = {}, extra: Partial<Widget> = {}): Widget => ({
  id: `web${++seq}-${Name}`,
  Type: Type as Widget['Type'],
  Name,
  Properties: props,
  ...extra,
})
const pad = (l: number, t: number, r = l, b = t) => ({ Left: l, Top: t, Right: r, Bottom: b })

export function webLayoutFixtures(): WebLayoutFixture[] {
  return [
    {
      name: '网页竖排和横排',
      size: { X: 1200, Y: 800 },
      root: w(
        'Frame',
        'Page',
        { Width: 'fill', Height: 'fill', Direction: 'column', Gap: 20, Padding: pad(40, 24) },
        {
          Children: [
            w(
              'Frame',
              'Header',
              {
                Direction: 'row',
                JustifyContent: 'between',
                AlignItems: 'center',
                Height: 64,
                Padding: pad(16, 0),
                BorderWidth: 1,
              },
              {
                Children: [
                  w('Frame', 'Logo', { Width: 120, Height: 32 }),
                  w(
                    'Frame',
                    'Nav',
                    { Direction: 'row', Gap: 12 },
                    {
                      Children: [
                        w('Frame', 'N1', { Width: 60, Height: 24 }),
                        w('Frame', 'N2', { Width: 80, Height: 24 }),
                      ],
                    },
                  ),
                ],
              },
            ),
            w(
              'Frame',
              'Hero',
              { Direction: 'row', Gap: 24, Height: 300 },
              {
                Children: [
                  w('Frame', 'Left', { Width: 'fill' }),
                  w('Frame', 'Right', { Width: 'fill', Padding: pad(10, 10) }),
                  w(
                    'Frame',
                    'Side',
                    { Width: 200, AlignItems: 'center' },
                    {
                      Children: [w('Frame', 'Dot', { Width: 40, Height: 40 })],
                    },
                  ),
                ],
              },
            ),
            w('Divider', 'Line', { Thickness: 2 }),
            w(
              'Frame',
              'Centered',
              { Direction: 'row', JustifyContent: 'center', Height: 60 },
              {
                Children: [w('Frame', 'Btn', { Width: 160, Height: 40 }, { Slot: { AlignSelf: 'center' } })],
              },
            ),
            w(
              'Frame',
              'Rest',
              { Height: 'fill', Direction: 'row', JustifyContent: 'evenly', AlignItems: 'end' },
              {
                Children: [w('Frame', 'A', { Width: 100, Height: 50 }), w('Frame', 'B', { Width: 100, Height: 80 })],
              },
            ),
          ],
        },
      ),
    },
    {
      name: '网页换行和绝对定位',
      size: { X: 900, Y: 700 },
      root: w(
        'Frame',
        'Page',
        { Width: 'fill', Height: 'fill', Direction: 'column', Padding: pad(20, 20) },
        {
          Children: [
            w(
              'Frame',
              'Grid',
              { Direction: 'row', Wrap: true, Gap: 16, AlignItems: 'start' },
              {
                Children: ['C1', 'C2', 'C3', 'C4', 'C5'].map((n) =>
                  w(
                    'Frame',
                    n,
                    { Width: 260, Height: 120, Direction: 'column' },
                    {
                      Children: [
                        w(
                          'Frame',
                          `${n}Badge`,
                          { Width: 30, Height: 20 },
                          { Slot: { Position: 'absolute', Pin: 'top-right', X: 8, Y: 8 } },
                        ),
                      ],
                    },
                  ),
                ),
              },
            ),
            w(
              'Frame',
              'Box',
              { Width: 400, Height: 200, BorderWidth: 2 },
              {
                Children: [
                  w(
                    'Frame',
                    'Center',
                    { Width: 50, Height: 30 },
                    { Slot: { Position: 'absolute', Pin: 'center', X: 10, Y: -5 } },
                  ),
                  w(
                    'Frame',
                    'Corner',
                    { Width: 'fill', Height: 20 },
                    { Slot: { Position: 'absolute', Pin: 'bottom-left', X: 0, Y: 0 } },
                  ),
                ],
              },
            ),
          ],
        },
      ),
    },
    {
      name: '网页文字和控件',
      size: { X: 800, Y: 600 },
      root: w(
        'Frame',
        'Page',
        { Width: 'fill', Height: 'fill', Direction: 'column', Gap: 12, Padding: pad(24, 24) },
        {
          Children: [
            w('Text', 'Title', { Text: 'Welcome to the shop', FontSize: 32, Tag: 'h1' }),
            w('Text', 'Body', {
              Text: '这是一段比较长的介绍文字，放在固定宽度的容器里会自动换行，后面的控件跟着往下排。',
              FontSize: 16,
              Width: 300,
            }),
            w(
              'Frame',
              'Actions',
              { Direction: 'row', Gap: 8, AlignItems: 'center' },
              {
                Children: [
                  w('WebButton', 'Buy', { Text: 'Buy now', Padding: pad(16, 8) }),
                  w('Input', 'Email', { Placeholder: 'you@example.com', Padding: pad(8, 6), BorderWidth: 1 }),
                  w('Picture', 'Pic', { Width: 64, Height: 48 }),
                ],
              },
            ),
            w('Frame', 'After', { Height: 40 }),
          ],
        },
      ),
    },
  ]
}
