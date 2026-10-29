import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
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
import { CircleStop, Play, UserCheck, Workflow as WorkflowIcon } from 'lucide-react'
import type { Agent, Flow, StepStatus } from '@shared/schema'
import { t } from '@shared/i18n'
import { END, START, wouldCycle } from '@shared/flow'
import { cn } from '@/lib/utils'
import { cliColor } from '@/lib/cli-style'
import { StepIcon } from '@/components/tasks/TaskStatusIcon'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'

export type HookSlot = 'start' | 'review' | 'end'
export const HOOK_LABEL: Record<HookSlot, string> = { start: t('开始'), review: t('验收'), end: t('结束') }

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
  /** 完成后等用户确认 */
  confirm?: boolean
  /** 节点里有几步执行者 */
  count?: number
  /** 多步节点的各步：卡片里逐行列出，运行视图里带上每一步的状态 */
  units?: { id: string; title: string; status?: StepStatus }[]
  /** 运行视图：节点底部的耗时和 token 用量（编辑器里没有） */
  stats?: { time: string; tokens: string }
}

type CardData = { view: NodeView }
type TermData = { kind: 'start' | 'end'; label: string; sub?: string; status?: StepStatus }

// 起止节点的状态：只描一圈，不染底
const ring: Record<StepStatus, string> = {
  pending: '',
  running: 'node-running',
  done: 'ring-1 ring-success/40',
  failed: 'ring-1 ring-danger/50',
  skipped: 'opacity-55',
}

/**
 * 节点卡片按状态染浅底（照设计稿：完成浅绿、运行中青色描框、失败浅红），
 * 胶囊文字和颜色与 StatusPill 的五种口径一致；没有状态（编辑器里）就是白卡片
 */
const STATE: Record<StepStatus, { tone: StatusTone; label: string; card: string }> = {
  pending: { tone: 'idle', label: t('计划中'), card: '' },
  running: { tone: 'run', label: t('运行中'), card: 'node-running bg-[color-mix(in_oklab,var(--run)_7%,var(--card))]' },
  done: {
    tone: 'ok',
    label: t('完成'),
    card: 'bg-[color-mix(in_oklab,var(--success)_8%,var(--card))] ring-1 ring-success/30',
  },
  failed: {
    tone: 'err',
    label: t('失败'),
    card: 'bg-[color-mix(in_oklab,var(--danger)_6%,var(--card))] ring-1 ring-danger/40',
  },
  skipped: { tone: 'idle', label: t('跳过'), card: 'opacity-55' },
}

/** 卡片里最多列几步：再多就写「还有 n 步」，卡片不会高过自动排列的行距（shared/flow 的 ROW） */
const UNIT_MAX = 3

/** 卡片里的小胶囊比列表里的再矮一号，节点高度不变，已经排好的流程图不会重叠 */
const pillSm = 'h-[1.125rem] gap-1 px-1.5 text-[0.65625rem]'

/**
 * 流程图里的一个节点：标题和状态胶囊在上，执行者标签、说明块在中间，开始 / 验收 / 结束流程在底部。
 * 选中只高亮节点自己（主题色描边和柔光），执行中有缓慢呼吸的光晕。
 */
const CardNode = memo(function CardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const v = data.view
  const agent = v.kind === 'agent' ? v.agent : undefined
  const units = v.units && v.units.length > 1 ? v.units : undefined
  // 多步节点没有列出步骤时，标签里写各步的串联和「+n」；列出了步骤，标签就和单步节点一样写第一步的执行者
  const chain = !!(v.count && v.count > 1) && !units
  const stats = v.stats && (v.stats.time || v.stats.tokens) ? v.stats : undefined
  const st = v.status ? STATE[v.status] : undefined
  // 染了底的卡片里，标签和说明块用白底托出来；白卡片里用浅灰底
  const block = st && st.card && v.status !== 'skipped' ? 'bg-card/85' : 'bg-sel/55'
  return (
    <div
      className={cn(
        'group/node flex w-[264px] flex-col gap-1.5 overflow-hidden rounded-xl bg-card p-2.5 text-left shadow-card transition-[box-shadow,transform] duration-150',
        'hover:shadow-pop',
        st?.card,
        v.loose && 'opacity-80 outline-1 -outline-offset-1 outline-line-strong outline-dashed',
        selected && 'node-selected',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex min-w-0 items-center gap-1.5">
        {v.kind === 'flow' && <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 truncate text-[0.84375rem] leading-5 font-semibold tracking-[-0.005em]">
          {v.title}
        </span>
        {st ? (
          <StatusPill tone={st.tone} spin={v.status === 'running'} className={pillSm}>
            {st.label}
          </StatusPill>
        ) : (
          v.loose && (
            <StatusPill tone="wait" className={pillSm}>
              {t('未连接')}
            </StatusPill>
          )
        )}
      </div>
      {/* 执行者标签：角色 · 模型；多步节点列出各步，流程节点写调用的流程 */}
      <div className="flex min-w-0 items-center gap-1.5 text-[0.71875rem] leading-4">
        <span className={cn('flex h-[1.375rem] min-w-0 items-center gap-1.5 rounded-md px-1.5', block)}>
          {v.kind === 'flow' ? (
            <span className="truncate text-muted">
              {t('调用流程')} · {v.flowText || t('未选择')}
            </span>
          ) : agent ? (
            <>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cliColor(agent.cli) }} />
              {/* 名字优先显示，模型挤在后面截断 */}
              <span className={cn('truncate', !chain && 'max-w-[60%] shrink-0', !agent.enabled && 'text-subtle')}>
                {chain ? v.sub : agent.name}
              </span>
              {!chain && v.model && (
                <span className="min-w-0 shrink truncate font-mono text-[0.65625rem] text-subtle">· {v.model}</span>
              )}
            </>
          ) : (
            <span className="truncate text-warning">{v.sub}</span>
          )}
        </span>
        {chain ? (
          <span className="shrink-0 rounded-md bg-sel px-1 text-[0.65625rem] leading-4 font-medium text-muted">
            +{(v.count ?? 1) - 1}
          </span>
        ) : (
          v.main &&
          agent && (
            <span className="shrink-0 rounded-md bg-accent-soft px-1 text-[0.65625rem] leading-4 font-medium text-accent">
              {t('主')}
            </span>
          )
        )}
      </div>
      {/* 多步节点逐行列出各步（照设计稿），说明块让给步骤列表，卡片高度不超过自动排列的行距 */}
      {units ? (
        <ol aria-label={t('节点里的步骤')} className="flex flex-col gap-1">
          {units.slice(0, UNIT_MAX).map((u, i) => (
            <li
              key={u.id}
              className={cn(
                'flex h-[1.375rem] min-w-0 items-center gap-1.5 rounded-md px-2 text-[0.6875rem] leading-4',
                block,
              )}
            >
              <span className={cn('min-w-0 flex-1 truncate', u.status === 'running' ? 'font-medium' : 'text-muted')}>
                {u.title}
              </span>
              {u.status && u.status !== 'pending' ? (
                <StepIcon status={u.status} className="h-3 w-3 shrink-0" />
              ) : (
                <span className="shrink-0 font-mono text-[0.625rem] text-subtle">{i + 1}</span>
              )}
            </li>
          ))}
          {units.length > UNIT_MAX && (
            <li className="px-2 text-[0.65625rem] leading-4 text-subtle">
              {t('还有 {n} 步', { n: units.length - UNIT_MAX })}
            </li>
          )}
        </ol>
      ) : (
        /* 说明块：行数截断放在没有内边距的元素上，否则第三行会从内边距里露出半截 */
        v.note && (
          <div className={cn('rounded-md px-2 py-1', block)}>
            <p className="line-clamp-2 text-[0.6875rem] leading-normal text-muted">{v.note}</p>
          </div>
        )
      )}
      {/* 底部一行：挂载的流程、等我确认，运行视图里再在右边写耗时和 token（颜色跟着状态：完成绿、运行中青）。
          耗时和挂载流程放同一行，旧的流程图按原来的行距排好的，加了这一行也不会上下叠在一起 */}
      {(v.hooks.length > 0 || v.confirm || stats) && (
        <div className="mt-auto flex flex-wrap items-center gap-1">
          {v.hooks.map((h) => (
            <span
              key={h.slot}
              title={t('{slot}：{label}', { slot: HOOK_LABEL[h.slot], label: h.label })}
              className={cn(
                'inline-flex h-[1.125rem] max-w-full items-center gap-1 rounded-md px-1.5 text-[0.65625rem]',
                h.slot === 'review' ? 'bg-accent-soft text-accent' : 'text-subtle',
                h.slot !== 'review' && block,
              )}
            >
              {h.status && h.status !== 'pending' && <StepIcon status={h.status} className="h-3 w-3" />}
              <span className="shrink-0 font-medium">{HOOK_LABEL[h.slot]}</span>
              {h.label && <span className="truncate">{h.label}</span>}
              {h.extra && <span className="shrink-0 opacity-75">{h.extra}</span>}
            </span>
          ))}
          {v.confirm && (
            <span className="inline-flex h-[1.125rem] items-center gap-1 rounded-md bg-warning/12 px-1.5 text-[0.65625rem] text-warning">
              <UserCheck className="h-3 w-3" />
              {t('等我确认')}
            </span>
          )}
          {stats && (
            <span
              aria-label={t('耗时和用量')}
              className={cn(
                'ml-auto inline-flex h-[1.125rem] items-center gap-2 text-[0.6875rem] tabular-nums',
                v.status === 'done' ? 'text-success' : v.status === 'running' ? 'text-run' : 'text-subtle',
              )}
            >
              {stats.time && <span>{stats.time}</span>}
              {stats.tokens && <span className="font-mono">{stats.tokens}</span>}
            </span>
          )}
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
        'flex items-center gap-2 rounded-full bg-card py-1.5 pr-4 pl-1.5 shadow-card transition-shadow hover:shadow-pop',
        selected && 'node-selected',
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
        <span className="text-[0.8125rem] leading-4 font-medium">{data.label}</span>
        {data.sub && <span className="max-w-[140px] truncate text-[0.6875rem] leading-4 text-subtle">{data.sub}</span>}
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
    // 节点第一次量好尺寸时适配一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
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
  data,
}: EdgeProps) {
  const dx = Math.max(Math.abs(targetX - sourceX) * 0.5, 40)
  const path = `M${sourceX},${sourceY} C${sourceX + dx},${sourceY} ${targetX - dx},${targetY} ${targetX},${targetY}`
  const when = (data as { when?: string } | undefined)?.when
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />
      {when && (
        // 有条件的线在中间标出走这条线的结论
        <EdgeLabelRenderer>
          <span
            className={cn(
              'nodrag nopan pointer-events-none absolute rounded-full px-1.5 py-px text-[0.6875rem] leading-4 font-medium',
              // 底色要不透明，盖住穿过的连线
              when === 'pass'
                ? 'bg-[color-mix(in_oklab,var(--success)_12%,var(--card))] text-success'
                : 'bg-[color-mix(in_oklab,var(--danger)_10%,var(--card))] text-danger',
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${(sourceY + targetY) / 2}px)`,
            }}
          >
            {when === 'pass' ? t('通过') : t('不通过')}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
const edgeTypes = { flow: FlowEdge }

export type EdgeTone = 'idle' | 'active' | 'done'

/** 连线颜色用主题 token：完成 = 绿（success），运行中 = 青（run），其余跟随画布的默认线色 */
const EDGE_COLOR: Record<EdgeTone, string> = {
  idle: 'var(--xy-edge-stroke)',
  active: 'var(--run)',
  done: 'var(--success)',
}

/** 三种状态的箭头，和 xyflow 自带的 ArrowClosed 同形 */
function ArrowMarkers({ id }: { id: (tone: EdgeTone) => string }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0">
      <defs>
        {(Object.keys(EDGE_COLOR) as EdgeTone[]).map((tone) => (
          <marker
            key={tone}
            id={id(tone)}
            viewBox="-10 -10 20 20"
            markerWidth="16"
            markerHeight="16"
            markerUnits="strokeWidth"
            orient="auto-start-reverse"
            refX="0"
            refY="0"
          >
            <polyline
              points="-5,-4 0,0 -5,4 -5,-4"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1"
              style={{ stroke: EDGE_COLOR[tone], fill: EDGE_COLOR[tone] }}
            />
          </marker>
        ))}
      </defs>
    </svg>
  )
}

/** 小地图里的节点和画布同色：完成绿、运行中青，其余灰 */
const miniColor = (n: Node) => {
  const d = n.data as Partial<CardData> & Partial<TermData>
  const st = d.view?.status ?? d.status
  if (st === 'done') return 'color-mix(in oklab, var(--success) 45%, var(--card))'
  if (st === 'running') return 'color-mix(in oklab, var(--run) 50%, var(--card))'
  if (st === 'failed') return 'color-mix(in oklab, var(--danger) 45%, var(--card))'
  return 'var(--line-strong)'
}

export function FlowCanvas({
  flow,
  views,
  startSub,
  terms,
  editable,
  selected,
  onSelect,
  onChange,
  panMode,
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
  /** 流程图改了；拖动节点时带上 key（一次拖动从按下到松手同一个），撤销历史按它把一次拖动合成一步 */
  onChange?: (f: Flow, key?: string) => void
  /** 平移模式：左键在空白处拖动画布，不拉选框 */
  panMode?: boolean
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
        data: { kind: 'start', label: t('开始'), sub: startSub, status: terms?.start } satisfies TermData,
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
        data: { kind: 'end', label: t('结束'), status: terms?.end } satisfies TermData,
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
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  // 正在框选时不处理连线的选中，否则框住的连线会抢走选中
  const boxing = useRef(false)

  // 箭头用自己画的 <marker>，id 按状态名生成（xyflow 自带的箭头按颜色字符串生成 id，用不了 CSS 变量）；
  // 页面上可能同时有几张流程图，id 带上这张图的前缀，不会互相引用到别人的（藏起来的那张会让箭头消失）
  const markerId = (tone: EdgeTone) => `flow-arrow-${uid}-${tone}`
  const edges: Edge[] = flow.edges.map((e) => {
    const tone = edgeTone?.(e.from, e.to) ?? 'idle'
    return {
      id: e.id,
      type: 'flow',
      source: e.from,
      target: e.to,
      selected: selected === `edge:${e.id}`,
      data: { when: e.when ?? '' },
      className: tone === 'active' ? 'edge-active' : undefined,
      style: tone === 'idle' ? undefined : { stroke: EDGE_COLOR[tone], strokeWidth: 2 },
      markerEnd: markerId(tone),
    }
  })

  const move = (id: string, p: { x: number; y: number }, f: Flow): Flow =>
    id === START
      ? { ...f, startPos: p }
      : id === END
        ? { ...f, endPos: p }
        : { ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n)) }

  // 这一次拖动的 key：按下后第一次移动时生成，松手（dragging 变成 false）时清掉
  const dragKey = useRef('')
  const onNodesChange = (changes: NodeChange[]) => {
    const next = applyNodeChanges(changes, nodes)
    setNodes(next)
    let f = flow
    let changed = false
    let key: string | undefined
    let removed = false
    for (const c of changes) {
      if (c.type === 'position' && c.position && editable) {
        f = move(c.id, c.position, f)
        changed = true
        if (!dragKey.current) dragKey.current = `move:${Date.now()}`
        key = dragKey.current
        if (!c.dragging) dragKey.current = ''
      } else if (c.type === 'remove' && editable && c.id !== START && c.id !== END) {
        f = {
          ...f,
          nodes: f.nodes.filter((n) => n.id !== c.id),
          edges: f.edges.filter((e) => e.from !== c.id && e.to !== c.id),
        }
        changed = true
        removed = true
        if (selected === c.id) report('')
      }
    }
    if (changes.some((c) => c.type === 'select')) {
      // 选中一个时显示它的设置；框选了多个时不显示单个节点的设置
      const picked = next.filter((n) => n.selected).map((n) => n.id)
      if (picked.length === 1) report(picked[0])
      else if (picked.length > 1) report('')
    }
    if (changed) onChange?.(f, removed ? undefined : key)
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
    if (!c.source || !c.target) return t('无效的连线')
    if (c.source === END || c.target === START) return t('开始只能连出，结束只能连入')
    if (c.source === c.target) return t('不能连到自己')
    if (flow.edges.some((e) => e.from === c.source && e.to === c.target)) return t('已经有这条线了')
    if (wouldCycle(flow, c.source, c.target)) return t('这条线会形成循环；需要反复修改时，用节点的「验收」流程')
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
    // 按画布自己的宽度（容器查询）决定放不放小地图：属性栏拉宽后画布很窄，小地图会压住底部工具条
    <div className={cn('@container relative min-h-0', className)} onContextMenu={(e) => e.preventDefault()}>
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
        panOnDrag={editable && !panMode ? [1, 2] : true}
        selectionOnDrag={!!editable && !panMode}
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
        <ArrowMarkers id={markerId} />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.6} />
        <Controls showInteractive={false} position="bottom-left" />
        {flow.nodes.length > 4 && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            ariaLabel={t('小地图')}
            className="!m-4 hidden overflow-hidden rounded-[10px] !bg-card shadow-pop @2xl:block"
            style={{ width: 180, height: 110 }}
            maskColor="color-mix(in oklab, var(--bg) 70%, transparent)"
            nodeColor={miniColor}
            nodeBorderRadius={3}
            nodeStrokeWidth={0}
          />
        )}
      </ReactFlow>
    </div>
  )
}
