import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  getNodesBounds,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type ReactFlowInstance,
  type Connection,
  type Edge,
  type EdgeChange,
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
  running: 'ring-2 ring-accent/60 border-accent',
  done: 'border-success/60',
  failed: 'ring-2 ring-danger/40 border-danger',
  skipped: 'opacity-60',
}

const CardNode = memo(function CardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const v = data.view
  return (
    <div
      className={cn(
        'w-[248px] rounded-[14px] border bg-card text-left shadow-card transition-[box-shadow,border-color]',
        v.status && ring[v.status],
        v.loose && 'border-dashed opacity-80',
        selected && 'border-accent shadow-pop ring-2 ring-accent/30',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
        {v.kind === 'agent' && v.agent ? (
          <AgentAvatar icon={v.agent.icon} cli={v.agent.cli} size="sm" dim={!v.agent.enabled} />
        ) : (
          <span
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
              v.kind === 'flow' ? 'bg-accent-soft text-accent' : 'bg-field text-subtle',
            )}
          >
            <WorkflowIcon className="h-4 w-4" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] leading-5 font-medium">{v.title}</span>
          <span className="truncate text-[11.5px] text-subtle">
            {v.kind === 'flow' ? `调用流程 · ${v.flowText || '未选择'}` : v.sub}
          </span>
        </span>
        {v.status && v.status !== 'pending' && <StepIcon status={v.status} className="mt-0.5" />}
      </div>
      {v.note && <p className="line-clamp-2 px-3 pb-2.5 text-[11.5px] leading-relaxed text-subtle">{v.note}</p>}
      {(v.hooks.length > 0 || v.loose) && (
        <div className="flex flex-wrap gap-1 border-t px-2.5 py-2">
          {v.loose && <span className="rounded-md bg-warning/12 px-1.5 py-0.5 text-[11px] text-warning">未连接</span>}
          {v.hooks.map((h) => (
            <span
              key={h.slot}
              title={`${HOOK_LABEL[h.slot]}：${h.label}`}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]',
                h.slot === 'review' ? 'bg-accent-soft text-accent' : 'bg-field text-muted',
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
        'flex items-center gap-2 rounded-full border bg-card py-1.5 pr-4 pl-1.5 shadow-card',
        selected && 'border-accent ring-2 ring-accent/30',
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
  const zoom = Math.max(0.6, Math.min(1, fit))
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
  const [nodes, setNodes] = useState<Node[]>(built)
  useEffect(
    () =>
      setNodes((prev) => {
        const old = new Map(prev.map((n) => [n.id, n]))
        return built.map((n) => {
          const p = old.get(n.id)
          return p
            ? { ...n, measured: p.measured, dragging: p.dragging, position: p.dragging ? p.position : n.position }
            : n
        })
      }),
    [built],
  )
  const shown = nodes.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected }))

  const edges: Edge[] = flow.edges.map((e) => {
    const tone = edgeTone?.(e.from, e.to) ?? 'idle'
    // 箭头的 id 由颜色生成，这里用固定色值
    const color = tone === 'done' ? '#4f9a6b' : tone === 'active' ? '#d97757' : undefined
    return {
      id: e.id,
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
    setNodes((ns) => applyNodeChanges(changes, ns))
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
        if (selected === c.id) onSelect('')
      } else if (c.type === 'select' && c.selected) onSelect(c.id)
    }
    if (changed) onChange?.(f)
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    let f = flow
    let changed = false
    for (const c of changes) {
      if (c.type === 'select' && c.selected) onSelect(`edge:${c.id}`)
      else if (c.type === 'remove' && editable) {
        f = { ...f, edges: f.edges.filter((e) => e.id !== c.id) }
        changed = true
        if (selected === `edge:${c.id}`) onSelect('')
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
    <div className={cn('relative min-h-0', className)}>
      <ReactFlow
        nodes={shown}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(c) => !check(c)}
        onPaneClick={() => onSelect('')}
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
        defaultEdgeOptions={{ type: 'default' }}
        connectionRadius={28}
        className={cn(!editable && 'read-only')}
      >
        <AutoFit />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  )
}
