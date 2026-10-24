/**
 * ComfyUI 接口格式节点图的自动排布：按依赖从上游到下游分列（列 = 最长上游链），
 * 同列按上下游重心排序减少连线交叉，没有上下游的节点单独放在最右列。
 * 面板预览和导入 ComfyUI 生成节点坐标都用这里，保证两边看到的方向一致。
 */

export interface ComfyLayoutNode {
  class_type: string
  inputs: Record<string, unknown>
}

export type ComfyLayoutGraph = Record<string, ComfyLayoutNode>

export interface ComfyLayoutOptions {
  /** 列间距：这一列节点左边到下一列左边的距离 */
  columnWidth: number
  /** 节点宽度，用来算整体尺寸 */
  nodeWidth: number
  /** 同列相邻节点之间的空隙 */
  rowGap: number
  /** 节点高度：接口格式里量不到，按输入数量估一个不会重叠的值 */
  nodeHeight: (node: ComfyLayoutNode) => number
}

export interface ComfyLayout {
  /** 节点 id → 左上角坐标 */
  positions: Map<string, { x: number; y: number }>
  /** 每一列按从上到下的顺序；最后一个是孤立节点列（如果有） */
  columns: string[][]
  /** 没有上下游、单独放在最右列的节点 */
  isolated: string[]
  width: number
  height: number
}

/** 连到别的节点的输入写成 [节点 id, 输出序号] */
const linkOf = (v: unknown): string | null =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' ? v[0] : null

/** 面板预览用的尺寸：和 ComfyNode 的节点宽度、输入行高一致 */
export const PANEL_GRAPH_LAYOUT: ComfyLayoutOptions = {
  columnWidth: 300,
  nodeWidth: 260,
  rowGap: 36,
  // 标题行 + 每个输入一行 + 上下内边距
  nodeHeight: (n) => 48 + Object.keys(n.inputs).length * 28,
}

/**
 * 导入 ComfyUI 用的尺寸：那边的节点宽、高都比面板大得多，而且高度按类型差很多，
 * 宁可留足空隙，也不要同列重叠。节点高度按输入数量估，最小按带预览的图片节点留
 */
export const COMFYUI_GRAPH_LAYOUT: ComfyLayoutOptions = {
  columnWidth: 460,
  nodeWidth: 360,
  rowGap: 60,
  nodeHeight: (n) => Math.max(300, 150 + Object.keys(n.inputs).length * 26),
}

/** 数字 id 按数值排，其它按字符排，保证同样的图每次排出来一样 */
const compareId = (a: string, b: string): number => {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a < b ? -1 : a > b ? 1 : 0
}

/** 连到别的节点的输入算依赖：去重，指向自己和指向不存在节点的忽略 */
function depsOf(graph: ComfyLayoutGraph, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const node = graph[id]
  if (!node) return out
  for (const v of Object.values(node.inputs ?? {})) {
    const dep = linkOf(v)
    if (dep && dep !== id && graph[dep] && !seen.has(dep)) {
      seen.add(dep)
      out.push(dep)
    }
  }
  return out
}
export function layoutComfyGraph(
  graph: ComfyLayoutGraph,
  options: ComfyLayoutOptions = PANEL_GRAPH_LAYOUT,
): ComfyLayout {
  const ids = Object.keys(graph)
  if (!ids.length) return { positions: new Map(), columns: [], isolated: [], width: 0, height: 0 }

  const deps = new Map(ids.map((id) => [id, depsOf(graph, id)]))
  const children = new Map(ids.map((id) => [id, [] as string[]]))
  for (const id of ids) for (const dep of deps.get(id)!) children.get(dep)!.push(id)

  // 拓扑排序定深度：没有上游的在第 0 列，其余放在最深的上游右边一列。
  // 接口格式理论上没有环；真遇到环也按能看到的上游给个深度，不让排布卡死
  const indegree = new Map(ids.map((id) => [id, deps.get(id)!.length]))
  const queue = ids.filter((id) => indegree.get(id) === 0).sort(compareId)
  const depth = new Map<string, number>()
  while (queue.length) {
    const id = queue.shift()!
    let d = 0
    for (const dep of deps.get(id)!) d = Math.max(d, (depth.get(dep) ?? -1) + 1)
    depth.set(id, d)
    for (const child of children.get(id)!) {
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  for (const id of ids) {
    if (depth.has(id)) continue
    let d = 0
    for (const dep of deps.get(id)!) d = Math.max(d, (depth.get(dep) ?? -1) + 1)
    depth.set(id, d)
  }

  // 没有上下游的节点不参与数据流，单独放最右列，免得和源头挤在同一列
  const isolatedSet = new Set(ids.filter((id) => deps.get(id)!.length === 0 && children.get(id)!.length === 0))
  const isolated = ids.filter((id) => isolatedSet.has(id)).sort(compareId)

  let columns: string[][] = []
  for (const id of ids.slice().sort(compareId)) {
    if (isolatedSet.has(id)) continue
    const d = depth.get(id)!
    if (!columns[d]) columns[d] = []
    columns[d].push(id)
  }
  columns = columns.filter((col) => col?.length)
  const heightOf = (id: string) => Math.max(0, options.nodeHeight(graph[id]))
  const yCenter = new Map<string, number>()
  const stack = () => {
    for (const col of columns) {
      let y = 0
      for (const id of col) {
        yCenter.set(id, y + heightOf(id) / 2)
        y += heightOf(id) + options.rowGap
      }
    }
  }
  // 列内顺序按上下游节点的平均高度排：上游偏上的排在上面，下游偏上的排在上面。
  // 前后交替几轮，连线交叉会明显减少
  const reorder = (indices: number[], neighbors: (id: string) => string[]) => {
    for (const ci of indices) {
      const col = columns[ci]
      if (!col || col.length < 2) continue
      const rank = new Map(col.map((id, i) => [id, i]))
      const key = new Map<string, number>()
      for (const id of col) {
        const ys = neighbors(id)
          .map((n) => yCenter.get(n))
          .filter((y): y is number => y !== undefined)
        key.set(id, ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : yCenter.get(id)!)
      }
      col.sort((a, b) => key.get(a)! - key.get(b)! || rank.get(a)! - rank.get(b)!)
    }
  }
  stack()
  const forward = columns.map((_, i) => i).slice(1)
  const backward = columns
    .map((_, i) => i)
    .reverse()
    .slice(1)
  for (let round = 0; round < 4; round++) {
    reorder(forward, (id) => deps.get(id)!)
    stack()
    reorder(backward, (id) => children.get(id)!)
    stack()
  }

  if (isolated.length) columns.push(isolated)

  const heights = columns.map((col) => col.reduce((s, id) => s + heightOf(id) + options.rowGap, -options.rowGap))
  const maxH = heights.length ? Math.max(...heights) : 0
  const positions = new Map<string, { x: number; y: number }>()
  columns.forEach((col, ci) => {
    // 各列高度不一样，上下居中让整体更整齐、连线也更短
    let y = Math.max(0, (maxH - heights[ci]) / 2)
    for (const id of col) {
      positions.set(id, { x: ci * options.columnWidth, y })
      y += heightOf(id) + options.rowGap
    }
  })
  return {
    positions,
    columns,
    isolated,
    width: (columns.length - 1) * options.columnWidth + options.nodeWidth,
    height: maxH,
  }
}

/** 给 ComfyUI 界面格式（workflow JSON）用的节点坐标：id → [x, y] */
export function comfyUiPositions(graph: ComfyLayoutGraph): Record<string, [number, number]> {
  const { positions } = layoutComfyGraph(graph, COMFYUI_GRAPH_LAYOUT)
  return Object.fromEntries([...positions].map(([id, p]) => [id, [p.x, p.y] as [number, number]]))
}
