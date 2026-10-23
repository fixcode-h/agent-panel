import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getNodesBounds,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ComfyWorkflow } from '@shared/local-image'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

type Graph = ComfyWorkflow['graph']

/** ComfyUI 接口格式里，连到别的节点的输入写成 [节点 id, 第几个输出] */
const linkOf = (v: unknown): [string, number] | null =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' ? [v[0], v[1]] : null

interface NodeData extends Record<string, unknown> {
  id: string
  type: string
  title: string
  inputs: [string, unknown][]
  outputs: number[]
  readOnly: boolean
  onInput: (node: string, key: string, value: unknown) => void
}

const ROW = 28
const HEAD = 44
const COL = 300
/** 节点标题行加内边距的实际高度，用来算内容尺寸和画布高度 */
const NODE_HEAD = 48
/** 同列两个节点之间留的空隙 */
const GAP = 36
/** 节点宽（和 ComfyNode 的 w-[260px] 一致），用来估算内容宽度 */
const NODE_W = 260
/** 适应时四周留的空隙 */
const PAD = 20
/** 左边留给缩放控件（+/−/适应）的宽度，不让它压在节点上 */
const CONTROL_GUTTER = 48
/** 适应后缩得太小文字就看不清了：低于这个比例按它居中，剩下的靠拖动和「适应」看 */
const MIN_READABLE_ZOOM = 0.5
const MAX_ZOOM = 1
/** 画布最低高度，内容再少也留得住节点 */
const MIN_CANVAS_H = 220

/** 按连线分层：没有上游的放最左边，其余放在最深的上游右边一列。同时给出内容的外接尺寸 */
function layout(graph: Graph) {
  const depth = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id) || !graph[id]) return 0
    seen.add(id)
    let d = 0
    for (const v of Object.values(graph[id].inputs)) {
      const l = linkOf(v)
      if (l && graph[l[0]]) d = Math.max(d, visit(l[0], seen) + 1)
    }
    depth.set(id, d)
    return d
  }
  for (const id of Object.keys(graph)) visit(id, new Set())
  const cols = new Map<number, string[]>()
  for (const [id, d] of depth) cols.set(d, [...(cols.get(d) ?? []), id])
  const pos = new Map<string, { x: number; y: number }>()
  let maxDepth = 0
  let maxY = 0
  for (const [d, ids] of cols) {
    let y = 0
    for (const id of ids) {
      const inputs = Object.keys(graph[id].inputs).length
      pos.set(id, { x: d * COL, y })
      // 节点自己的高度（标题行 + 每个输入一行）加下面留的间隔
      y += NODE_HEAD + inputs * ROW + GAP
    }
    maxDepth = Math.max(maxDepth, d)
    maxY = Math.max(maxY, y - GAP)
  }
  return { pos, width: maxDepth * COL + NODE_W, height: maxY }
}

/** 视口高度，画布跟着它放大缩小 */
function useViewportHeight() {
  const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight))
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return height
}

function Field({ value, readOnly, onChange }: { value: unknown; readOnly: boolean; onChange: (v: unknown) => void }) {
  const shown = typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value)
  // 数字输到一半（如「0.」）还不是数，先留在本地，能解析成数时再写回
  const [text, setText] = useState(shown)
  useEffect(() => {
    if (typeof value !== 'number' || Number(text) !== value) setText(shown)
    // 只跟外部的值同步，text 是本地输入
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])
  if (typeof value === 'boolean')
    return (
      <input
        type="checkbox"
        className="nodrag h-3.5 w-3.5 accent-[var(--color-accent)]"
        checked={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  // 占位符由面板在出图时替换，标出来
  const slot = typeof value === 'string' && /\{\{\w+\}\}/.test(value)
  return (
    <input
      value={text}
      // 数组、对象这类值在图上不好改，到配置里改
      readOnly={readOnly || (typeof value !== 'string' && typeof value !== 'number')}
      title={text}
      spellCheck={false}
      onChange={(e) => {
        const s = e.target.value
        setText(s)
        if (typeof value !== 'number') return onChange(s)
        const n = Number(s)
        if (s.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
      className={cn(
        'nodrag h-[22px] min-w-0 flex-1 rounded border-0 bg-field px-1.5 font-mono text-[0.6875rem] outline-none focus:ring-1 focus:ring-focus',
        slot && 'text-accent',
      )}
    />
  )
}

const ComfyNode = memo(function ComfyNode({ data }: NodeProps<Node<NodeData>>) {
  return (
    <div className="w-[260px] rounded-xl border bg-card text-[0.75rem] shadow-card">
      <div className="flex items-baseline gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-medium" title={data.type}>
          {data.title || data.type}
        </span>
        <span className="shrink-0 font-mono text-[0.65625rem] text-subtle">#{data.id}</span>
      </div>
      <div className="relative flex flex-col py-1.5">
        {data.inputs.map(([key, v]) => {
          const link = linkOf(v)
          return (
            <div key={key} className="relative flex h-[28px] items-center gap-2 px-3">
              {link && (
                <Handle
                  type="target"
                  id={key}
                  position={Position.Left}
                  isConnectable={false}
                  className="!h-2 !w-2 !border-0 !bg-accent"
                />
              )}
              <span className={cn('w-[88px] shrink-0 truncate', link ? 'text-fg' : 'text-muted')} title={key}>
                {key}
              </span>
              {link ? (
                <span className="truncate font-mono text-[0.6875rem] text-subtle">
                  ← #{link[0]}
                  {link[1] ? ` · ${link[1]}` : ''}
                </span>
              ) : (
                <Field value={v} readOnly={data.readOnly} onChange={(nv) => data.onInput(data.id, key, nv)} />
              )}
            </div>
          )
        })}
        {data.outputs.map((o, i) => (
          <Handle
            key={o}
            type="source"
            id={String(o)}
            position={Position.Right}
            isConnectable={false}
            style={{ top: HEAD / 2 + 6 + i * 14 }}
            className="!h-2 !w-2 !border-0 !bg-accent"
          />
        ))}
      </div>
    </div>
  )
})

const nodeTypes = { comfy: ComfyNode }

/**
 * ComfyUI 接口格式的节点图，画成和流程图一样的节点和连线：
 * 每个节点列出输入，连到上游的画成连线，其他的值可以直接改（改动写回节点图的 JSON）。
 */
export function ComfyGraphView({
  graph,
  readOnly,
  onChange,
}: {
  graph: Graph
  readOnly: boolean
  onChange: (g: Graph) => void
}) {
  const ids = Object.keys(graph).join('|')
  // 节点位置只在节点增删时重新排，改值、拖动时保持
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const { pos, width: estimateW, height: estimateH } = useMemo(() => layout(graph), [ids])
  const [width, setWidth] = useState(0)
  // 节点真实尺寸（字号、内边距都算上）比估算准，量到之后高度按它算
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null)
  const viewportH = useViewportHeight()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setWidth(rect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])
  // 高度按内容实际占的高度给（适应后能填满），内容多时收在视口的一定比例内，不再写死一屏
  const height = useMemo(() => {
    const contentW = bounds?.width ?? estimateW
    const contentH = bounds?.height ?? estimateH
    const maxH = Math.max(MIN_CANVAS_H, Math.round(viewportH * 0.62))
    const fitW = width > PAD * 2 + CONTROL_GUTTER ? (width - PAD - CONTROL_GUTTER) / contentW : 1
    const zoom = Math.max(Math.min(MAX_ZOOM, fitW), MIN_READABLE_ZOOM)
    const wanted = contentH * Math.min(zoom, MAX_ZOOM) + PAD * 2
    return Math.round(Math.min(maxH, Math.max(MIN_CANVAS_H, wanted)))
  }, [width, bounds, estimateW, estimateH, viewportH])
  const [nodes, setNodes] = useState<Node<NodeData>[]>([])
  useEffect(() => {
    const used = new Map<string, Set<number>>()
    for (const n of Object.values(graph))
      for (const v of Object.values(n.inputs)) {
        const l = linkOf(v)
        if (l) used.set(l[0], (used.get(l[0]) ?? new Set()).add(l[1]))
      }
    const onInput = (node: string, key: string, value: unknown) =>
      onChange({ ...graph, [node]: { ...graph[node], inputs: { ...graph[node].inputs, [key]: value } } })
    setNodes((prev) =>
      Object.entries(graph).map(([id, n]) => ({
        id,
        type: 'comfy',
        position: prev.find((p) => p.id === id)?.position ?? pos.get(id) ?? { x: 0, y: 0 },
        data: {
          id,
          type: n.class_type,
          title: String((n as { _meta?: { title?: string } })._meta?.title ?? ''),
          inputs: Object.entries(n.inputs),
          outputs: [...(used.get(id) ?? [])].sort(),
          readOnly,
          onInput,
        },
      })),
    )
  }, [graph, pos, readOnly, onChange])
  const edges = useMemo<Edge[]>(
    () =>
      Object.entries(graph).flatMap(([id, n]) =>
        Object.entries(n.inputs).flatMap(([key, v]) => {
          const l = linkOf(v)
          return l && graph[l[0]]
            ? [
                {
                  id: `${l[0]}:${l[1]}->${id}:${key}`,
                  source: l[0],
                  sourceHandle: String(l[1]),
                  target: id,
                  targetHandle: key,
                  style: { stroke: 'var(--color-subtle)', strokeWidth: 1.4 },
                },
              ]
            : []
        }),
      ),
    [graph],
  )
  return (
    <div ref={box} className="overflow-hidden rounded-xl border bg-field/40" style={{ height }}>
      <ReactFlowProvider>
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          contentKey={`${ids}:${height}`}
          onBounds={setBounds}
          onNodesChange={(c: NodeChange<Node<NodeData>>[]) => setNodes((ns) => applyNodeChanges(c, ns))}
        />
      </ReactFlowProvider>
    </div>
  )
}

/**
 * 节点尺寸量好、容器尺寸变了、换了工作流时重新适应到可视区：能全部放进来的就整体居中；
 * 放进来的话要缩到看不清，就按可读的比例居中，超出部分靠拖动和「适应」看
 */
const GraphCanvas = memo(function GraphCanvas({
  nodes,
  edges,
  contentKey,
  onBounds,
  onNodesChange,
}: {
  nodes: Node<NodeData>[]
  edges: Edge[]
  contentKey: string
  onBounds: (b: { width: number; height: number }) => void
  onNodesChange: (c: NodeChange<Node<NodeData>>[]) => void
}) {
  const flow = useReactFlow()
  const ready = useNodesInitialized()
  const box = useRef<HTMLDivElement>(null)
  const last = useRef({ width: 0, height: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!ready || size.width < PAD * 2 || size.height < PAD * 2) return
    const bounds = getNodesBounds(flow.getNodes())
    if (!bounds.width || !bounds.height) return
    // 内容尺寸报给外层定画布高度；尺寸没变就不报，免得来回重算
    if (Math.abs(last.current.width - bounds.width) >= 1 || Math.abs(last.current.height - bounds.height) >= 1) {
      last.current = { width: bounds.width, height: bounds.height }
      onBounds(last.current)
    }
    const fit = Math.min(
      (size.width - PAD - CONTROL_GUTTER) / bounds.width,
      (size.height - PAD * 2) / bounds.height,
      MAX_ZOOM,
    )
    const zoom = Math.max(Math.min(MAX_ZOOM, fit), MIN_READABLE_ZOOM)
    // 左边留出控件的位置，剩下的空间里居中
    const areaW = size.width - PAD - CONTROL_GUTTER
    flow.setViewport(
      {
        x: CONTROL_GUTTER + (areaW - bounds.width * zoom) / 2 - bounds.x * zoom,
        y: (size.height - bounds.height * zoom) / 2 - bounds.y * zoom,
        zoom,
      },
      { duration: 0 },
    )
  }, [ready, size.width, size.height, contentKey, flow, onBounds])
  return (
    <div ref={box} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        aria-label={t('节点图')}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
})
