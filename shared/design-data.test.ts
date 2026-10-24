/**
 * 画板运行时假数据：绑定规则、状态覆盖、校验，以及导出时剔除。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATA_PROPS,
  dataRows,
  dataUsage,
  checkData,
  emptyData,
  normalizeData,
  propsForRow,
  withRow,
  type DesignData,
} from './design-data.ts'
import { exportDesign, newWidget, type Widget } from './umg.ts'
import { webExport } from './web.ts'

const data: DesignData = {
  sets: [
    {
      id: 'items',
      name: 'Items',
      label: '背包物品',
      fields: [
        { key: 'icon', label: '图标', type: 'image', widget: 'Icon', note: '' },
        { key: 'count', label: '数量', type: 'number', widget: 'Count', note: '' },
        { key: 'selected', label: '选中', type: 'boolean', widget: 'SlotRoot', note: '' },
      ],
      rows: [
        { icon: 'img:sword', count: 3, selected: true },
        { icon: '', count: 0, selected: false },
      ],
    },
  ],
}

const withProps = (w: Widget, props: Record<string, unknown>) => ({ ...w, Properties: { ...w.Properties, ...props } })

test('dataRows：绑定了集合就用集合的行数，没绑定或不存在的集合返回 undefined', () => {
  const grid = withProps(newWidget('UniformGridPanel', 'Grid'), { DataSet: 'items' })
  assert.equal(dataRows(data, grid)?.length, 2)
  assert.equal(dataRows(data, withProps(grid, { DataSet: '' })), undefined)
  assert.equal(dataRows(data, withProps(grid, { DataSet: 'nope' })), undefined)
})

test('withRow：文字、图片、进度条、勾选框按字段显示', () => {
  const text = withProps(newWidget('TextBlock', 'Count'), { DataField: 'count' })
  assert.equal(withRow(text, data.sets[0].rows[0]).Properties.Text, '3')

  const image = withProps(newWidget('Image', 'Icon'), { DataField: 'icon' })
  assert.equal(withRow(image, data.sets[0].rows[0]).Properties.Brush.ResourceObject, 'img:sword')
  // 空字符串：格子没有物品，图标隐藏
  assert.equal(withRow(image, data.sets[0].rows[1]).Properties.Visibility, 'Hidden')

  const bar = withProps(newWidget('ProgressBar', 'Hp'), { DataField: 'count' })
  assert.equal(withRow(bar, { count: 0.4 }).Properties.Percent, 0.4)

  const check = withProps(newWidget('CheckBox', 'Locked'), { DataField: 'selected' })
  assert.equal(withRow(check, { selected: true }).Properties.CheckedState, 'Checked')
  assert.equal(withRow(check, { selected: false }).Properties.CheckedState, 'Unchecked')
})

test('propsForRow：第一个匹配的状态覆盖属性，没有 When 的是默认状态', () => {
  const image = newWidget('Image', 'Icon')
  const states = [
    {
      Name: 'Selected',
      When: { Field: 'selected', Equals: true },
      Properties: { RenderOpacity: 1, Brush: { ResourceObject: 'img:selected' } },
    },
    { Name: 'Normal', Properties: { RenderOpacity: 0.5 } },
  ]
  const w = withProps(image, { States: states, Brush: { ResourceObject: 'img:normal' } })
  const on = propsForRow(w, { selected: true })
  assert.equal(on.RenderOpacity, 1)
  assert.equal(on.Brush.ResourceObject, 'img:selected')
  const off = propsForRow(w, { selected: false })
  assert.equal(off.RenderOpacity, 0.5)
  // 深合并：状态只写了 ResourceObject，原来的画刷字段还在
  assert.equal(typeof on.Brush.ResourceObject, 'string')
})

test('withRow：状态和数据字段可以一起用，不改原来的树', () => {
  const image = newWidget('Image', 'Icon')
  const w = withProps(image, {
    DataField: 'icon',
    States: [{ Name: 'Selected', When: { Field: 'selected', Equals: 'true' }, Properties: { RenderOpacity: 1 } }],
  })
  const row = { icon: 'img:potion', selected: true }
  const out = withRow(w, row)
  assert.equal(out.Properties.Brush.ResourceObject, 'img:potion')
  assert.equal(out.Properties.RenderOpacity, 1)
  assert.equal(w.Properties.Brush.ResourceObject, '')
})

test('dataUsage：列出每个集合用在哪些控件上', () => {
  const grid = withProps(newWidget('UniformGridPanel', 'Grid'), { DataSet: 'Items' })
  const root = { ...newWidget('CanvasPanel', 'Root'), Children: [grid] }
  const usage = dataUsage(root, [], data)
  assert.deepEqual(usage.get('items'), ['Grid'])
})

test('checkData：集合绑定不存在、图片引用不存在、字段重复', () => {
  const bad: DesignData = {
    sets: [
      {
        id: 'items',
        name: 'Items',
        label: '',
        fields: [
          { key: 'icon', label: '', type: 'image', widget: '', note: '' },
          { key: 'icon', label: '', type: 'image', widget: '', note: '' },
        ],
        rows: [{ icon: 'img:missing' }, { icon: 'not-an-image' }],
      },
    ],
  }
  const root = {
    ...newWidget('UniformGridPanel', 'Grid'),
    Properties: { ...newWidget('UniformGridPanel', 'X').Properties, DataSet: 'nope' },
  }
  const errors = checkData(bad, { imageIds: new Set(['exists']), root, components: [] })
  assert.ok(errors.some((e) => e.includes('字段重复')))
  assert.ok(errors.some((e) => e.includes('不存在的图片 missing')))
  assert.ok(errors.some((e) => e.includes('不是 "img:<图片 id>"')))
  assert.ok(errors.some((e) => e.includes('不存在的集合 nope')))
  assert.deepEqual(checkData(data, { imageIds: new Set(['sword']) }), [])
})

test('normalizeData：补 id，重复的 id 加序号', () => {
  const out = normalizeData({
    sets: [
      { id: '', name: 'Items', fields: [], rows: [] },
      { id: 'Items', name: 'Items', fields: [], rows: [] },
    ],
  })
  assert.equal(out.sets.length, 2)
  assert.notEqual(out.sets[0].id, out.sets[1].id)
  assert.deepEqual(normalizeData('bad', emptyData()), emptyData())
})

test('exportDesign：假数据和状态绑定都不进导出结果', () => {
  const icon = withProps(newWidget('Image', 'Icon'), {
    DataField: 'icon',
    States: [{ Name: 'Selected', When: { Field: 'selected', Equals: true }, Properties: { RenderOpacity: 1 } }],
  })
  const grid = {
    ...newWidget('UniformGridPanel', 'Grid'),
    Properties: {
      ...newWidget('UniformGridPanel', 'X').Properties,
      EntryWidgetClass: 'Slot',
      NumEntries: 2,
      NumColumns: 1,
      DataSet: 'items',
    },
  }
  const slot: Widget = { ...newWidget('Overlay', 'SlotRoot'), Children: [icon] }
  const root = { ...newWidget('CanvasPanel', 'Root'), Children: [grid] }
  const { json } = exportDesign({
    title: 'Bag',
    designSize: { X: 1920, Y: 1080 },
    root,
    components: [{ Name: 'Slot', DesignSize: { X: 112, Y: 112 }, Root: slot }],
    images: [],
  })
  const text = JSON.stringify(json)
  for (const p of DATA_PROPS) assert.ok(!text.includes(`"${p}"`), `导出结果里不该有 ${p}`)
  assert.ok(!text.includes('img:sword'))
  assert.ok(!text.includes('items'))
  assert.ok(text.includes('SlotRoot'))
})

test('webExport：状态和数据绑定也不出现在网页导出里', () => {
  const txt = withProps(newWidget('Text', 'Title'), {
    Text: '示例标题',
    DataField: 'title',
    States: [{ Name: 'Selected', When: { Field: 'selected', Equals: true }, Properties: { Color: '#FF0000FF' } }],
  })
  const page = {
    ...newWidget('Frame', 'Page'),
    Properties: { ...newWidget('Frame', 'Page').Properties, Width: 'fill', Height: 'fill' },
    Children: [txt],
  }
  const html = webExport({
    title: 'Test',
    designSize: { X: 1440, Y: 900 },
    root: page,
    components: [],
    file: () => undefined,
  })
  for (const p of [...DATA_PROPS, 'selected']) assert.ok(!html.includes(p), `网页导出里不该有 ${p}`)
  assert.ok(html.includes('示例标题'))
})
