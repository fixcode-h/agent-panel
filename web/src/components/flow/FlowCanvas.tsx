import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  getNodesBounds,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type ReactFlowInstance,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CircleStop, Play, Workflow as WorkflowIcon } from 'lucide-react'
import type { Agent, Flow, StepStatus } from '@shared/schema'
import { END, START, wouldCycle } from '@shared/flow'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { cliColor } from '@/lib/cli-style'
import { StepIcon } from '@/components/tasks/TaskStatusIcon'

export type HookSlot = 'start' | 'review' | 'end'
export const HOOK_LABEL: Record<HookSlot, string> = { start: '开始', review: '验收', end: '结束' }

/** 画布上一个节点要显示的内容，由调用方算好 */
export interface NodeView {
  title: string
  kind: 'agent' | 'flow'
  agent?: Agent
  /** Agent 下面的一行：模型或者「主 Agent」 */
  sub: string
  /** 用的是工作流的主 Agent */
  main?: boolean
  model?: string
  /** 流程节点调用的流程名 */
  flowText?: string
  note?: string
  hooks: { slot: HookSlot; label: string; status?: StepStatus; extra?: string }[]
  status?: StepStatus
  /** 没有从开始连到，不会执行 */
  loose?: boolean
}

type CardData = { view: NodeView }
type TermData = { kind: 'start' | 'end'; label: string; sub?: string; status?: StepStatus }

const ring: Record<StepStatus, string> = {
  pending: '',
  running: 'node-running border-accent',
  done: 'border-success/50',
  failed: 'ring-2 ring-danger/30 border-danger/70',
  skipped: 'opacity-55',
}

/**
 * 流程图里的一个节点：标题和执行者在上，模型、说明在中间，开始 / 验收 / 结束流程在底部。
 * 选中只高亮节点自己（主题色描边和柔光），执行中有缓慢呼吸的光晕。
 */
const CardNode = memo(function CardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const v = data.view
  const agent = v.kind === 'agent' ? v.agent : undefined
  return (
    <div
      className={cn(
        'group/node w-[264px] overflow-hidden rounded-2xl border bg-card text-left shadow-card transition-[box-shadow,border-color,transform] duration-150',
        'hover:border-line-strong hover:shadow-pop',
        v.status && ring[v.status],
        v.loose && 'border-dashed opacity-80',
        selected && 'node-selected border-accent',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
        {agent ? (
          <AgentAvatar icon={agent.icon} cli={agent.cli} size="md" dim={!agent.enabled} />
        ) : (
          <span
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-[9px]',
              v.kind === 'flow' ? 'bg-accent-soft text-accent' : 'bg-field text-subtle',
            )}
          >
            <WorkflowIcon className="h-[18px] w-[18px]" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13.5px] leading-5 font-semibold tracking-[-0.005em]">{v.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-subtle">
            {v.kind === 'flow' ? (
              <span className="truncate">调用流程 · {v.flowText || '未选择'}</span>
            ) : agent ? (
              <>
                <span className="truncate">{agent.name}</span>
                {v.main && (
                  <span className="shrink-0 rounded px-1 text-[10.5px] leading-4 font-medium text-accent ring-1 ring-accent/30 ring-inset">
                    主
                  </span>
                )}
                {/* 模型放在同一行，节点高度不变，已经排好的流程图不会重叠 */}
                {v.model && (
                  <span className="ml-auto flex min-w-0 shrink items-center gap-1 rounded bg-field px-1 font-mono text-[10.5px] leading-4 text-muted ring-1 ring-line ring-inset">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cliColor(agent.cli) }} />
                    <span className="truncate">{v.model}</span>
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-warning">{v.sub}</span>
            )}
          </span>
        </span>
        {v.status && v.status !== 'pending' && <StepIcon status={v.status} className="mt-0.5" />}
      </div>
      {/* 行数截断放在没有内边距的元素上，否则第三行会从内边距里露出半截 */}
      {v.note && (
        <div className="px-3.5 pb-3">
          <p className="line-clamp-2 text-[11.5px] leading-[1.6] text-subtle">{v.note}</p>
        </div>
      )}
      {(v.hooks.length > 0 || v.loose) && (
        <div className="flex flex-wrap gap-1 border-t bg-panel/60 px-3 py-2">
          {v.loose && <span className="rounded-md bg-warning/12 px-1.5 py-0.5 text-[11px] text-warning">未连接</span>}
          {v.hooks.map((h) => (
            <span
              key={h.slot}
              title={`${HOOK_LABEL[h.slot]}：${h.label}`}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]',
                h.slot === 'review' ? 'bg-accent-soft text-accent' : 'bg-field text-muted ring-1 ring-line ring-inset',
              )}
            >
              {h.status && h.status !== 'pending' && <StepIcon status={h.status} className="h-3 w-3" />}
              <span className="shrink-0 font-medium">{HOOK_LABEL[h.slot]}</span>
              <span className="truncate">{h.label}</span>
              {h.extra && <span className="shrink-0 opacity-75">{h.extra}</span>}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const TermNode = memo(function TermNode({ data, selected }: NodeProps<Node<TermData>>) {
  const start = data.kind === 'start'
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full border bg-card py-1.5 pr-4 pl-1.5 shadow-card transition-[box-shadow,border-color] hover:border-line-strong hover:shadow-pop',
        selected && 'node-selected border-accent',
        data.status && data.status !== 'pending' && ring[data.status],
      )}
    >
      {!start && <Handle type="target" position={Position.Left} />}
      <span
        className={cn('grid h-7 w-7 place-items-center rounded-full', start ? 'bg-accent text-white' : 'bg-fg text-bg')}
      >
        {start ? (
          <Play className="h-3.5 w-3.5 translate-x-px" fill="currentColor" />
        ) : (
          <CircleStop className="h-4 w-4" />
        )}
      </span>
      <span className="flex flex-col">
        <span className="text-[13px] leading-4 font-medium">{data.label}</span>
        {data.sub && <span className="max-w-[140px] truncate text-[11px] leading-4 text-subtle">{data.sub}</span>}
      </span>
      {start && <Handle type="source" position={Position.Right} />}
    </div>
  )
})

const nodeTypes = { card: CardNode, term: TermNode }

/**
 * 让流程图适合画布：放得下就居中显示全部；放不下时不缩得太小，从「开始」那一侧显示，其余拖动查看。
 */
export function smartFit(rf: ReactFlowInstance, el: HTMLElement | null, duration = 0) {
  const nodes = rf.getNodes()
  if (!el || !nodes.length) return
  const b = getNodesBounds(nodes)
  const W = el.clientWidth
  const H = el.clientHeight
  const pad = 48
  const fit = Math.min((W - pad * 2) / b.width, (H - pad * 2) / b.height)
  // 尽量整张图都放得下；太大时最小缩到 0.45，再小字就看不清了，剩下的靠小地图和拖动
  const zoom = Math.max(0.45, Math.min(1, fit))
  const x = zoom > fit ? pad - b.x * zoom : (W - b.width * zoom) / 2 - b.x * zoom
  const y = (H - b.height * zoom) / 2 - b.y * zoom
  void rf.setViewport({ x, y, zoom }, { duration })
}

function AutoFit() {
  const rf = useReactFlow()
  const ready = useNodesInitialized()
  const done = useRef(false)
  const dom = useStore((s) => s.domNode)
  useEffect(() => {
    if (!ready || done.current) return
    done.current = true
    smartFit(rf, dom)
  }, [ready])
  return null
}

/**
 * 连线：从右边水平出发、水平进入左边。React Flow 默认的曲线按两端距离算弯曲程度，
 * 节点挨得很近时几乎是一条斜线，箭头也跟着歪；这里控制点至少离端点 40px，近了也是平着进出。
 */
const FlowEdge = memo(function FlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps) {
  const dx = Math.max(Math.abs(targetX - sourceX) * 0.5, 40)
  const path = `M${sourceX},${sourceY} C${sourceX + dx},${sourceY} ${targetX - dx},${targetY} ${targetX},${targetY}`
  return <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />
})
const edgeTypes = { flow: FlowEdge }

export type EdgeTone = 'idle' | 'active' | 'done'

export function FlowCanvas({
  flow,
  views,
  startSub,
  terms,
  editable,
  selected,
  onSelect,
  onChange,
  onReject,
  onDropOnPane,
  edgeTone,
  className,
}: {
  flow: Flow
  views: Record<string, NodeView>
  startSub?: string
  terms?: { start?: StepStatus; end?: StepStatus }
  editable?: boolean
  /** 选中的节点 id、start、end，或 edge:连线 id */
  selected: string
  onSelect: (id: string) => void
  onChange?: (f: Flow) => void
  /** 连线不合法时的提示 */
  onReject?: (msg: string) => void
  /** 从节点拖出的线松手在空白处：reverse 表示是从节点左侧（输入端）拖出的 */
  onDropOnPane?: (d: { from: string; reverse: boolean; client: { x: number; y: number } }) => void
  edgeTone?: (from: string, to: string) => EdgeTone
  className?: string
}) {
  const built = useMemo<Node[]>(
    () => [
      {
        id: START,
        type: 'term',
        position: flow.startPos,
        deletable: false,
        data: { kind: 'start', label: '开始', sub: startSub, status: terms?.start } satisfies TermData,
      },
      ...flow.nodes.map(
        (n): Node => ({
          id: n.id,
          type: 'card',
          position: { x: n.x, y: n.y },
          data: { view: views[n.id] } satisfies CardData,
        }),
      ),
      {
        id: END,
        type: 'term',
        position: flow.endPos,
        deletable: false,
        data: { kind: 'end', label: '结束', status: terms?.end } satisfies TermData,
      },
    ],
    [flow, views, startSub, terms?.start, terms?.end],
  )

  // xyflow 需要保留节点的尺寸等内部状态，所以节点放在本地 state 里，内容变了再合并
  const [nodes, setNodes] = useState<Node[]>(() => built.map((n) => ({ ...n, selected: n.id === selected })))
  useEffect(
    () =>
      setNodes((prev) => {
        const old = new Map(prev.map((n) => [n.id, n]))
        return built.map((n) => {
          const p = old.get(n.id)
          return p
            ? {
                ...n,
                measured: p.measured,
                dragging: p.dragging,
                selected: p.selected,
                position: p.dragging ? p.position : n.position,
              }
            : n
        })
      }),
    [built],
  )
  // 节点的选中状态由画布自己管（框选能选中多个），只把「选中了哪一个」报给外面；
  // reported 记住报出去的值，外面改了选中（例如点了侧栏）才同步回画布
  const reported = useRef(selected)
  const report = (id: string) => {
    reported.current = id
    onSelect(id)
  }
  useEffect(() => {
    if (selected === reported.current) return
    reported.current = selected
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected })))
  }, [selected])
  // 正在框选时不处理连线的选中，否则框住的连线会抢走选中
  const boxing = useRef(false)

  const edges: Edge[] = flow.edges.map((e) => {
    const tone = edgeTone?.(e.from, e.to) ?? 'idle'
    // 箭头的 id 由颜色生成，这里用固定色值
    const color = tone === 'done' ? '#4f9a6b' : tone === 'active' ? '#d97757' : undefined
    return {
      id: e.id,
      type: 'flow',
      source: e.from,
      target: e.to,
      selected: selected === `edge:${e.id}`,
      className: tone === 'active' ? 'edge-active' : undefined,
      style: color ? { stroke: color, strokeWidth: 2 } : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, ...(color && { color }) },
    }
  })

  const move = (id: string, p: { x: number; y: number }, f: Flow): Flow =>
    id === START
      ? { ...f, startPos: p }
      : id === END
        ? { ...f, endPos: p }
        : { ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n)) }

  const onNodesChange = (changes: NodeChange[]) => {
    const next = applyNodeChanges(changes, nodes)
    setNodes(next)
    let f = flow
    let changed = false
    for (const c of changes) {
      if (c.type === 'position' && c.position && editable) {
        f = move(c.id, c.position, f)
        changed = true
      } else if (c.type === 'remove' && editable && c.id !== START && c.id !== END) {
        f = {
          ...f,
          nodes: f.nodes.filter((n) => n.id !== c.id),
          edges: f.edges.filter((e) => e.from !== c.id && e.to !== c.id),
        }
        changed = true
        if (selected === c.id) report('')
      }
    }
    if (changes.some((c) => c.type === 'select')) {
      // 选中一个时显示它的设置；框选了多个时不显示单个节点的设置
      const picked = next.filter((n) => n.selected).map((n) => n.id)
      if (picked.length === 1) report(picked[0])
      else if (picked.length > 1) report('')
    }
    if (changed) onChange?.(f)
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    let f = flow
    let changed = false
    for (const c of changes) {
      if (c.type === 'select' && c.selected && !boxing.current) report(`edge:${c.id}`)
      else if (c.type === 'remove' && editable) {
        f = { ...f, edges: f.edges.filter((e) => e.id !== c.id) }
        changed = true
        if (selected === `edge:${c.id}`) report('')
      }
    }
    if (changed) onChange?.(f)
  }

  const check = (c: Connection | Edge): string => {
    if (!c.source || !c.target) return '无效的连线'
    if (c.source === END || c.target === START) return '开始只能连出，结束只能连入'
    if (c.source === c.target) return '不能连到自己'
    if (flow.edges.some((e) => e.from === c.source && e.to === c.target)) return '已经有这条线了'
    if (wouldCycle(flow, c.source, c.target)) return '这条线会形成循环；需要反复修改时，用节点的「验收」流程'
    return ''
  }

  const onConnect = (c: Connection) => {
    const err = check(c)
    if (err) return onReject?.(err)
    onChange?.({
      ...flow,
      edges: [...flow.edges, { id: `e_${Math.random().toString(36).slice(2, 10)}`, from: c.source, to: c.target }],
    })
  }

  return (
    // 右键用来拖动画布，不弹浏览器菜单
    <div className={cn('relative min-h-0', className)} onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={(e, state) => {
          if (!editable || state.isValid || !state.fromNode) return
          if (state.toNode) {
            const from = state.fromHandle?.type === 'target' ? state.toNode.id : state.fromNode.id
            const to = state.fromHandle?.type === 'target' ? state.fromNode.id : state.toNode.id
            const err = check({ source: from, target: to, sourceHandle: null, targetHandle: null })
            if (err) onReject?.(err)
            return
          }
          const p = 'changedTouches' in e ? e.changedTouches[0] : e
          onDropOnPane?.({
            from: state.fromNode.id,
            reverse: state.fromHandle?.type === 'target',
            client: { x: p.clientX, y: p.clientY },
          })
        }}
        isValidConnection={(c) => !check(c)}
        onPaneClick={() => report('')}
        // 鼠标：左键点选、按住拖动节点；左键在空白处拖出选框，框住的节点可以一起拖；右键（或中键）按住拖动画布。
        // 只读时没有编辑，左键也可以拖动画布
        panOnDrag={editable ? [1, 2] : true}
        selectionOnDrag={!!editable}
        selectionMode={SelectionMode.Partial}
        onSelectionStart={() => (boxing.current = true)}
        onSelectionEnd={() => (boxing.current = false)}
        nodesDraggable={!!editable}
        nodesConnectable={!!editable}
        edgesFocusable={!!editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        minZoom={0.3}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'flow' }}
        edgeTypes={edgeTypes}
        connectionRadius={28}
        className={cn(!editable && 'read-only')}
      >
        <AutoFit />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        <Controls showInteractive={false} position="bottom-left" />
        {flow.nodes.length > 4 && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            ariaLabel="小地图"
            className="!m-3 hidden overflow-hidden rounded-lg border !bg-card sm:block"
            style={{ width: 150, height: 96 }}
            maskColor="color-mix(in oklab, var(--bg) 70%, transparent)"
            nodeColor="var(--line-strong)"
            nodeStrokeWidth={0}
          />
        )}
      </ReactFlow>
    </div>
  )
}
