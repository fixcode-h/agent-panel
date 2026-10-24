import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMFYUI_GRAPH_LAYOUT,
  PANEL_GRAPH_LAYOUT,
  comfyUiPositions,
  layoutComfyGraph,
  type ComfyLayoutGraph,
} from './comfy-layout.ts'

const node = (inputs: Record<string, unknown> = {}) => ({ class_type: 'Test', inputs })
const link = (id: string) => [id, 0]

test('按依赖分列：菱形里的汇合节点放在两个分支的右边', () => {
  const g: ComfyLayoutGraph = {
    '1': node(),
    '2': node({ model: link('1') }),
    '3': node({ clip: link('1') }),
    '4': node({ a: link('2'), b: link('3') }),
  }
  const l = layoutComfyGraph(g)
  assert.equal(l.columns.length, 3)
  assert.deepEqual(l.columns[0], ['1'])
  assert.deepEqual(new Set(l.columns[1]), new Set(['2', '3']))
  assert.deepEqual(l.columns[2], ['4'])
  assert.equal(l.positions.get('1')!.x, 0)
  assert.equal(l.positions.get('2')!.x, PANEL_GRAPH_LAYOUT.columnWidth)
  assert.equal(l.positions.get('4')!.x, PANEL_GRAPH_LAYOUT.columnWidth * 2)
})

test('多输入取最深的上游：同时接源头和中间节点时排到中间节点右边', () => {
  const g: ComfyLayoutGraph = {
    '1': node(),
    '2': node({ model: link('1') }),
    '3': node({ a: link('1'), b: link('2') }),
  }
  const l = layoutComfyGraph(g)
  assert.deepEqual(l.columns, [['1'], ['2'], ['3']])
})

test('孤立节点单独放最右列，不和数据流的源头挤在一起', () => {
  const g: ComfyLayoutGraph = {
    '1': node(),
    '2': node({ model: link('1') }),
    '9': node({ value: 3 }),
  }
  const l = layoutComfyGraph(g)
  assert.deepEqual(l.columns, [['1'], ['2'], ['9']])
  assert.deepEqual(l.isolated, ['9'])
  assert.equal(l.positions.get('9')!.x, PANEL_GRAPH_LAYOUT.columnWidth * 2)
})
test('同列节点纵向不重叠，而且列的左边对齐', () => {
  const g: ComfyLayoutGraph = {
    '1': node({ a: link('2'), b: link('3'), c: link('4') }),
    '2': node({ x: 1 }),
    '3': node({ x: 1, y: 2 }),
    '4': node({ x: 1, y: 2, z: 3 }),
  }
  const l = layoutComfyGraph(g)
  for (const col of l.columns) {
    const xs = new Set(col.map((id) => l.positions.get(id)!.x))
    assert.equal(xs.size, 1)
    const sorted = [...col].sort((a, b) => l.positions.get(a)!.y - l.positions.get(b)!.y)
    for (let i = 1; i < sorted.length; i++) {
      const prev = l.positions.get(sorted[i - 1])!
      const cur = l.positions.get(sorted[i])!
      const prevH = PANEL_GRAPH_LAYOUT.nodeHeight(g[sorted[i - 1]])
      assert.ok(cur.y >= prev.y + prevH + PANEL_GRAPH_LAYOUT.rowGap - 0.001, `${sorted[i]} 压在 ${sorted[i - 1]} 上`)
    }
  }
})

test('列内按上下游重心排序：上下游顺序相反的会翻过来，减少交叉', () => {
  const g: ComfyLayoutGraph = {
    '1': node(),
    '2': node(),
    '3': node({ model: link('2') }),
    '4': node({ model: link('1') }),
  }
  const l = layoutComfyGraph(g)
  // 4 接上面的 1，3 接下面的 2：第二列排成 4、3 才不交叉
  assert.deepEqual(l.columns[1], ['4', '3'])
})
test('同样的图每次排出来一样', () => {
  const g: ComfyLayoutGraph = {
    '1': node(),
    '2': node({ model: link('1') }),
    '3': node({ model: link('1') }),
    '4': node({ a: link('2'), b: link('3') }),
  }
  const a = layoutComfyGraph(g)
  const b = layoutComfyGraph(g)
  assert.deepEqual([...a.positions], [...b.positions])
  assert.deepEqual(a.columns, b.columns)
})

test('空图返回空排布，不会算出负数尺寸', () => {
  const l = layoutComfyGraph({})
  assert.equal(l.positions.size, 0)
  assert.equal(l.width, 0)
  assert.equal(l.height, 0)
})

test('自引用和指向不存在节点的输入不算依赖，按孤立节点处理', () => {
  const g: ComfyLayoutGraph = {
    '1': node({ self: link('1'), missing: link('99') }),
  }
  const l = layoutComfyGraph(g)
  assert.deepEqual(l.isolated, ['1'])
  assert.deepEqual(l.columns, [['1']])
})

test('有环的图不会卡死，每个节点都有位置', () => {
  const g: ComfyLayoutGraph = {
    '1': node({ a: link('2') }),
    '2': node({ b: link('1') }),
  }
  const l = layoutComfyGraph(g)
  assert.equal(l.positions.size, 2)
  assert.ok(Number.isFinite(l.positions.get('1')!.x))
})

test('ComfyUI 坐标按它自己的列宽排，节点从左到右', () => {
  const g: ComfyLayoutGraph = {
    '1': node({ model: link('2') }),
    '2': node(),
    '3': node({ model: link('1') }),
  }
  const pos = comfyUiPositions(g)
  assert.deepEqual(Object.keys(pos), ['1', '2', '3'])
  assert.equal(pos['2'][0], 0)
  assert.equal(pos['1'][0], COMFYUI_GRAPH_LAYOUT.columnWidth)
  assert.equal(pos['3'][0], COMFYUI_GRAPH_LAYOUT.columnWidth * 2)
  for (const id of Object.keys(pos)) {
    assert.equal(pos[id].length, 2)
    assert.ok(pos[id][1] >= 0)
  }
})
